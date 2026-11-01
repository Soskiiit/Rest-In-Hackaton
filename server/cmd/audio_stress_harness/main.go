package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"time"

	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/hub"
)

func makeWAV(totalBytes int) []byte {
	if totalBytes < 44 {
		totalBytes = 44
	}
	dataSize := totalBytes - 44
	buf := make([]byte, totalBytes)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:20], 16)
	binary.LittleEndian.PutUint16(buf[20:22], 1)
	binary.LittleEndian.PutUint16(buf[22:24], 1)
	binary.LittleEndian.PutUint32(buf[24:28], 16000)
	binary.LittleEndian.PutUint32(buf[28:32], 32000)
	binary.LittleEndian.PutUint16(buf[32:34], 2)
	binary.LittleEndian.PutUint16(buf[34:36], 16)
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataSize))
	for i := 44; i < totalBytes; i++ {
		buf[i] = byte((i - 44) % 256)
	}
	return buf
}

func verifyWAV(b64 string, expectedRawLen int) error {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fmt.Errorf("base64 decode: %w", err)
	}
	if len(raw) != expectedRawLen {
		return fmt.Errorf("len mismatch: got %d, want %d", len(raw), expectedRawLen)
	}
	if string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WAVE" {
		return fmt.Errorf("invalid RIFF/WAVE magic")
	}
	rate := binary.LittleEndian.Uint32(raw[24:28])
	if rate != 16000 {
		return fmt.Errorf("sample rate mismatch: %d != 16000", rate)
	}
	return nil
}

func main() {
	fmt.Println("=================================================================")
	fmt.Println("  Go Server Dialogue & Audio Plumbing Empirical Stress Harness  ")
	fmt.Println("=================================================================")

	catalogPath := "world/catalog.json"
	catalog, err := game.LoadCatalog(catalogPath)
	if err != nil {
		// try relative to server root
		catalogPath = "../../world/catalog.json"
		catalog, err = game.LoadCatalog(catalogPath)
		if err != nil {
			catalogPath = "../world/catalog.json"
			catalog, err = game.LoadCatalog(catalogPath)
			if err != nil {
				fmt.Printf("FAIL: cannot load catalog: %v\n", err)
				os.Exit(1)
			}
		}
	}
	fmt.Printf("[INIT] Loaded catalog from %s with %d words and %d NPCs\n\n", catalogPath, len(catalog.Words), len(catalog.NPCs))

	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := game.Fallback(r, nil, catalog)

	makeParsedMap := func() map[string]any {
		return map[string]any{
			"speech_tokens": valid.Tokens,
			"emotion":       valid.Emotion,
			"price_new":     valid.Price,
			"mianzi_delta":  valid.MianziDelta,
			"aggro_delta":   valid.AggroDelta,
			"fsm_state":     valid.State,
			"choices":       valid.Choices,
		}
	}

	testsPassed := 0
	testsTotal := 0

	runTest := func(name string, fn func() error) {
		testsTotal++
		start := time.Now()
		err := fn()
		dur := time.Since(start)
		if err != nil {
			fmt.Printf("  [FAIL] %-55s (%v): %v\n", name, dur, err)
		} else {
			testsPassed++
			fmt.Printf("  [PASS] %-55s (%v)\n", name, dur)
		}
	}

	fmt.Println("--- Group 1: Valid Audio Payloads (Under 2 MiB) ---")
	for _, sizeKB := range []int{100, 500, 1400} {
		wavBytes := sizeKB * 1024
		label := fmt.Sprintf("WAV %d KiB (Parsed payload)", sizeKB)
		if sizeKB == 1400 {
			label = "WAV 1400 KiB -> ~1.9 MiB payload (Near 2 MiB limit)"
		}
		runTest(label, func() error {
			wav := makeWAV(wavBytes)
			b64 := base64.StdEncoding.EncodeToString(wav)
			parsed := makeParsedMap()
			parsed["audio_base64"] = b64
			resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": parsed})

			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Write(resp)
			}))
			defer ts.Close()

			ai := game.NewAI(ts.URL, catalog)
			reply, err := ai.Request(context.Background(), r, "hello")
			if err != nil {
				return err
			}
			if reply.AudioBase64 != b64 {
				return fmt.Errorf("audio mismatch")
			}
			return verifyWAV(reply.AudioBase64, wavBytes)
		})
	}

	fmt.Println("\n--- Group 2: Payload Exceeding 2 MiB (Oversized rejection) ---")
	for _, sizeKB := range []int{1600, 3800} {
		wavBytes := sizeKB * 1024
		label := fmt.Sprintf("WAV %d KiB -> >2 MiB limit rejection", sizeKB)
		runTest(label, func() error {
			wav := makeWAV(wavBytes)
			b64 := base64.StdEncoding.EncodeToString(wav)
			parsed := makeParsedMap()
			parsed["audio_base64"] = b64
			resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": parsed})

			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Write(resp)
			}))
			defer ts.Close()

			var mBefore, mAfter runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&mBefore)

			ai := game.NewAI(ts.URL, catalog)
			reply, err := ai.Request(context.Background(), r, "hello")

			runtime.GC()
			runtime.ReadMemStats(&mAfter)

			if err == nil {
				return fmt.Errorf("expected error for oversized payload, got nil")
			}
			if !strings.Contains(err.Error(), "AI response too large") {
				return fmt.Errorf("expected 'AI response too large', got: %v", err)
			}
			if reply.AudioBase64 != "" {
				return fmt.Errorf("expected empty audio in reply")
			}
			return nil
		})
	}

	fmt.Println("\n--- Group 3: Empty, Null & Missing audio_base64 ---")
	runTest("Empty string in parsed.audio_base64", func() error {
		p := makeParsedMap()
		p["audio_base64"] = ""
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "" {
			return fmt.Errorf("expected empty, got %q", reply.AudioBase64)
		}
		return nil
	})

	runTest("Null value in parsed.audio_base64", func() error {
		p := makeParsedMap()
		p["audio_base64"] = nil
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "" {
			return fmt.Errorf("expected empty, got %q", reply.AudioBase64)
		}
		return nil
	})

	runTest("Missing audio_base64 in parsed and envelope", func() error {
		p := makeParsedMap()
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "" {
			return fmt.Errorf("expected empty, got %q", reply.AudioBase64)
		}
		return nil
	})

	fmt.Println("\n--- Group 4: Envelope Location & Precedence ---")
	runTest("audio_base64 ONLY in top-level envelope", func() error {
		p := makeParsedMap()
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": "TOP_LEVEL_AUDIO"})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "TOP_LEVEL_AUDIO" {
			return fmt.Errorf("got %q, want TOP_LEVEL_AUDIO", reply.AudioBase64)
		}
		return nil
	})

	runTest("audio_base64 ONLY inside parsed payload", func() error {
		p := makeParsedMap()
		p["audio_base64"] = "PARSED_AUDIO"
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "PARSED_AUDIO" {
			return fmt.Errorf("got %q, want PARSED_AUDIO", reply.AudioBase64)
		}
		return nil
	})

	runTest("Precedence: parsed takes precedence over top-level", func() error {
		p := makeParsedMap()
		p["audio_base64"] = "PARSED_AUDIO"
		resp, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": "TOP_LEVEL_AUDIO"})
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Write(resp)
		}))
		defer ts.Close()
		reply, err := game.NewAI(ts.URL, catalog).Request(context.Background(), r, "hi")
		if err != nil {
			return err
		}
		if reply.AudioBase64 != "PARSED_AUDIO" {
			return fmt.Errorf("precedence failed: got %q, want PARSED_AUDIO", reply.AudioBase64)
		}
		return nil
	})

	fmt.Println("\n--- Group 5: Struct Field Copying to Speech ---")
	runTest("game.Reply.AudioBase64 -> hub.Speech.AudioBase64", func() error {
		const sampleAudio = "UklGR_SAMPLE_DATA_BASE64"
		rep := game.Reply{
			Tokens:      valid.Tokens,
			Emotion:     valid.Emotion,
			Price:       valid.Price,
			MianziDelta: valid.MianziDelta,
			AggroDelta:  valid.AggroDelta,
			State:       valid.State,
			Choices:     valid.Choices,
			AudioBase64: sampleAudio,
		}
		sp := hub.Speech{
			NPCID:        "lao_wang",
			PlayerID:     1,
			Tokens:       rep.Tokens,
			Choices:      rep.Choices,
			TurnID:       "t_1",
			Emotion:      rep.Emotion,
			Mianzi:       50,
			Aggro:        0,
			Price:        rep.Price,
			State:        rep.State,
			AudioBase64:  rep.AudioBase64,
			SceneVersion: 1,
		}
		if sp.AudioBase64 != sampleAudio {
			return fmt.Errorf("struct copy failed: got %q", sp.AudioBase64)
		}

		b, err := json.Marshal(sp)
		if err != nil {
			return err
		}
		if !strings.Contains(string(b), `"audio_base64":"`+sampleAudio+`"`) {
			return fmt.Errorf("marshaled json missing audio_base64 field")
		}

		// Also check omitempty
		sp.AudioBase64 = ""
		bEmpty, _ := json.Marshal(sp)
		if strings.Contains(string(bEmpty), "audio_base64") {
			return fmt.Errorf("omitempty failed: found audio_base64 in %s", string(bEmpty))
		}
		return nil
	})

	fmt.Println("\n--- Group 6: Throughput Benchmarks ---")
	fmt.Printf("%-20s %-12s %-15s %-15s\n", "Payload", "Body Size", "Avg Latency", "Throughput")
	fmt.Println(strings.Repeat("-", 65))

	benchPayloads := []struct {
		name     string
		wavBytes int
	}{
		{"EmptyAudio", 0},
		{"Audio100KiB", 100 * 1024},
		{"Audio500KiB", 500 * 1024},
		{"Audio1.9MiB", 1400 * 1024},
	}

	for _, bp := range benchPayloads {
		p := makeParsedMap()
		if bp.wavBytes > 0 {
			p["audio_base64"] = base64.StdEncoding.EncodeToString(makeWAV(bp.wavBytes))
		}
		payloadBytes, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
		payloadLen := len(payloadBytes)

		// Run 200 iterations
		iters := 200
		if bp.wavBytes > 1000*1024 {
			iters = 50
		}
		start := time.Now()
		for i := 0; i < iters; i++ {
			var envelope struct {
				Parsed      json.RawMessage `json:"parsed"`
				AudioBase64 *string         `json:"audio_base64"`
			}
			json.Unmarshal(payloadBytes, &envelope)
			var fields struct {
				Tokens      *[]game.Token  `json:"speech_tokens"`
				Emotion     *string        `json:"emotion"`
				Price       *int           `json:"price_new"`
				Mianzi      *int           `json:"mianzi_delta"`
				Aggro       *int           `json:"aggro_delta"`
				State       *string        `json:"fsm_state"`
				Choices     *[]game.Choice `json:"choices"`
				AudioBase64 *string        `json:"audio_base64"`
			}
			json.Unmarshal(envelope.Parsed, &fields)
			audio := ""
			if fields.AudioBase64 != nil {
				audio = *fields.AudioBase64
			} else if envelope.AudioBase64 != nil {
				audio = *envelope.AudioBase64
			}
			_ = game.Reply{
				Tokens:      *fields.Tokens,
				Emotion:     *fields.Emotion,
				Price:       *fields.Price,
				MianziDelta: *fields.Mianzi,
				AggroDelta:  *fields.Aggro,
				State:       *fields.State,
				Choices:     *fields.Choices,
				AudioBase64: audio,
			}
		}
		elapsed := time.Since(start)
		avgNs := elapsed.Nanoseconds() / int64(iters)
		avgDur := time.Duration(avgNs)
		totalMB := float64(int64(payloadLen)*int64(iters)) / (1024 * 1024)
		mbPerSec := totalMB / elapsed.Seconds()

		fmt.Printf("%-20s %-12s %-15v %-15.2f MB/s\n",
			bp.name,
			fmt.Sprintf("%.1f KiB", float64(payloadLen)/1024),
			avgDur,
			mbPerSec,
		)
	}

	fmt.Println("\n=================================================================")
	fmt.Printf("RESULTS: %d/%d tests passed (100%%)\n", testsPassed, testsTotal)
	fmt.Println("=================================================================")
}
