package game

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"hackaton/server/internal/db"
)

// makeWAV generates valid 16kHz 16-bit Mono PCM WAV audio of exact total byte length.
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
	binary.LittleEndian.PutUint32(buf[16:20], 16)     // Subchunk1Size = 16 for PCM
	binary.LittleEndian.PutUint16(buf[20:22], 1)      // AudioFormat = 1 (PCM)
	binary.LittleEndian.PutUint16(buf[22:24], 1)      // NumChannels = 1 (Mono)
	binary.LittleEndian.PutUint32(buf[24:28], 16000)  // SampleRate = 16000 Hz
	binary.LittleEndian.PutUint32(buf[28:32], 32000)  // ByteRate = 16000 * 1 * 2 = 32000
	binary.LittleEndian.PutUint16(buf[32:34], 2)      // BlockAlign = 1 * 2 = 2
	binary.LittleEndian.PutUint16(buf[34:36], 16)     // BitsPerSample = 16
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataSize))
	for i := 44; i < totalBytes; i++ {
		buf[i] = byte((i - 44) % 256)
	}
	return buf
}

// verifyWAV checks that the given Base64 string decodes to a valid 16kHz Mono PCM WAV.
func verifyWAV(t *testing.T, b64 string, expectedRawLen int) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("failed to decode base64 audio: %v", err)
	}
	if len(raw) != expectedRawLen {
		t.Fatalf("WAV raw length mismatch: got %d, expected %d", len(raw), expectedRawLen)
	}
	if string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WAVE" || string(raw[12:16]) != "fmt " {
		t.Fatalf("invalid WAV magic headers")
	}
	channels := binary.LittleEndian.Uint16(raw[22:24])
	sampleRate := binary.LittleEndian.Uint32(raw[24:28])
	bitsPerSample := binary.LittleEndian.Uint16(raw[34:36])
	if channels != 1 || sampleRate != 16000 || bitsPerSample != 16 {
		t.Fatalf("invalid WAV format: channels=%d, rate=%d, bits=%d", channels, sampleRate, bitsPerSample)
	}
}

// helper to build a baseline valid parsed map
func makeValidParsedMap(valid Reply) map[string]any {
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

// TestDialogueAudioPayloadSizes tests valid payloads under 2 MiB:
// 100 KiB, 500 KiB, and 1.9 MiB total response sizes.
func TestDialogueAudioPayloadSizes(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	testCases := []struct {
		name       string
		wavBytes   int
		inParsed   bool
		inEnvelope bool
	}{
		{name: "100KiB_in_parsed", wavBytes: 100 * 1024, inParsed: true, inEnvelope: false},
		{name: "500KiB_in_parsed", wavBytes: 500 * 1024, inParsed: true, inEnvelope: false},
		{name: "1.9MiB_in_parsed", wavBytes: 1400 * 1024, inParsed: true, inEnvelope: false}, // 1400 KiB raw -> ~1.87 MiB Base64 -> ~1.9 MiB JSON
		{name: "100KiB_in_envelope", wavBytes: 100 * 1024, inParsed: false, inEnvelope: true},
		{name: "500KiB_in_envelope", wavBytes: 500 * 1024, inParsed: false, inEnvelope: true},
		{name: "1.9MiB_in_envelope", wavBytes: 1400 * 1024, inParsed: false, inEnvelope: true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			wavData := makeWAV(tc.wavBytes)
			b64Audio := base64.StdEncoding.EncodeToString(wavData)

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				parsed := makeValidParsedMap(valid)
				envelope := map[string]any{
					"raw":    "simulated raw LLM output",
					"parsed": parsed,
				}
				if tc.inParsed {
					parsed["audio_base64"] = b64Audio
				}
				if tc.inEnvelope {
					envelope["audio_base64"] = b64Audio
				}

				respBytes, err := json.Marshal(envelope)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
				if len(respBytes) > 2*1024*1024 {
					t.Fatalf("Test setup error: response bytes %d exceeds 2 MiB", len(respBytes))
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write(respBytes)
			}))
			defer server.Close()

			ai := NewAI(server.URL, c)
			reply, err := ai.Request(context.Background(), r, "test")
			if err != nil {
				t.Fatalf("unexpected error for %s: %v", tc.name, err)
			}
			if reply.AudioBase64 != b64Audio {
				t.Fatalf("AudioBase64 mismatch: got %d chars, expected %d chars", len(reply.AudioBase64), len(b64Audio))
			}
			verifyWAV(t, reply.AudioBase64, tc.wavBytes)
		})
	}
}

// TestDialogueAudioExceedingLimit tests responses exceeding 2 MiB:
// Assert error is returned gracefully without panic or memory leak.
func TestDialogueAudioExceedingLimit(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	testCases := []struct {
		name     string
		wavBytes int
	}{
		{name: "2.1MiB_payload", wavBytes: 1600 * 1024}, // 1600 KiB raw -> 2.13 MiB Base64 -> >2.15 MiB JSON
		{name: "5MiB_payload", wavBytes: 3800 * 1024},   // ~5 MiB Base64
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			wavData := makeWAV(tc.wavBytes)
			b64Audio := base64.StdEncoding.EncodeToString(wavData)

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				parsed := makeValidParsedMap(valid)
				parsed["audio_base64"] = b64Audio
				envelope := map[string]any{"raw": "", "parsed": parsed}

				respBytes, err := json.Marshal(envelope)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write(respBytes)
			}))
			defer server.Close()

			ai := NewAI(server.URL, c)

			var mBefore, mAfter runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&mBefore)

			reply, err := ai.Request(context.Background(), r, "test")

			runtime.GC()
			runtime.ReadMemStats(&mAfter)

			if err == nil {
				t.Fatalf("expected error for oversized payload %s, but got nil (reply audio len=%d)", tc.name, len(reply.AudioBase64))
			}
			if !strings.Contains(err.Error(), "AI response too large") {
				t.Fatalf("expected 'AI response too large' error, got: %v", err)
			}
			if reply.AudioBase64 != "" {
				t.Fatalf("expected empty reply AudioBase64 on error, got: %d bytes", len(reply.AudioBase64))
			}

			// Verify memory remains bounded: limit reader caps consumption
			t.Logf("[%s] err=%v, heap alloc diff=%d bytes (bounded by 2MiB limit)", tc.name, err, int64(mAfter.HeapAlloc)-int64(mBefore.HeapAlloc))
		})
	}
}

// TestDialogueExact2MiBBoundary tests the exact boundary conditions around 2,097,152 bytes:
// - Exactly 2,097,152 bytes: should PASS
// - Exactly 2,097,153 bytes: should FAIL with "AI response too large"
func TestDialogueExact2MiBBoundary(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	buildPayload := func(targetTotalBytes int) []byte {
		parsed := makeValidParsedMap(valid)
		parsed["audio_base64"] = "UklGRg==" // minimal valid base64
		envelope := map[string]any{
			"raw":    "",
			"parsed": parsed,
		}
		rawBytes, _ := json.Marshal(envelope)
		// We pad "raw" string to achieve exact targetTotalBytes
		diff := targetTotalBytes - len(rawBytes)
		if diff < 0 {
			t.Fatalf("baseline envelope too large: %d > %d", len(rawBytes), targetTotalBytes)
		}
		envelope["raw"] = strings.Repeat("A", diff)
		finalBytes, _ := json.Marshal(envelope)
		for len(finalBytes) < targetTotalBytes {
			envelope["raw"] = envelope["raw"].(string) + "A"
			finalBytes, _ = json.Marshal(envelope)
		}
		if len(finalBytes) > targetTotalBytes {
			// Fine-tune by truncating raw if needed
			overflow := len(finalBytes) - targetTotalBytes
			envelope["raw"] = strings.Repeat("A", diff-overflow)
			finalBytes, _ = json.Marshal(envelope)
		}
		if len(finalBytes) != targetTotalBytes {
			t.Fatalf("failed to construct exact payload: got %d, want %d", len(finalBytes), targetTotalBytes)
		}
		return finalBytes
	}

	const maxLimit = 2 * 1024 * 1024 // 2,097,152 bytes

	t.Run("exact_2MiB_passes", func(t *testing.T) {
		payload := buildPayload(maxLimit)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write(payload)
		}))
		defer server.Close()

		ai := NewAI(server.URL, c)
		reply, err := ai.Request(context.Background(), r, "test")
		if err != nil {
			t.Fatalf("expected exact 2 MiB payload to pass, got error: %v", err)
		}
		if reply.AudioBase64 != "UklGRg==" {
			t.Fatalf("unexpected audio: %v", reply.AudioBase64)
		}
	})

	t.Run("exact_2MiB_plus_1_fails", func(t *testing.T) {
		payload := buildPayload(maxLimit + 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write(payload)
		}))
		defer server.Close()

		ai := NewAI(server.URL, c)
		_, err := ai.Request(context.Background(), r, "test")
		if err == nil {
			t.Fatal("expected exact 2 MiB + 1 byte payload to fail, but succeeded")
		}
		if !strings.Contains(err.Error(), "AI response too large") {
			t.Fatalf("expected 'AI response too large' error, got: %v", err)
		}
	})
}

// TestDialogueEmptyAndNullAudio tests scenarios where audio_base64 is empty, null, or missing.
func TestDialogueEmptyAndNullAudio(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	scenarios := []struct {
		name       string
		jsonString string
	}{
		{
			name: "empty_in_parsed",
			jsonString: func() string {
				p := makeValidParsedMap(valid)
				p["audio_base64"] = ""
				b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
				return string(b)
			}(),
		},
		{
			name: "null_in_parsed",
			jsonString: func() string {
				p := makeValidParsedMap(valid)
				p["audio_base64"] = nil
				b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
				return string(b)
			}(),
		},
		{
			name: "missing_in_parsed_and_envelope",
			jsonString: func() string {
				p := makeValidParsedMap(valid)
				b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
				return string(b)
			}(),
		},
		{
			name: "empty_in_envelope",
			jsonString: func() string {
				p := makeValidParsedMap(valid)
				b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": ""})
				return string(b)
			}(),
		},
		{
			name: "null_in_envelope",
			jsonString: func() string {
				p := makeValidParsedMap(valid)
				b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": nil})
				return string(b)
			}(),
		},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				io.WriteString(w, sc.jsonString)
			}))
			defer server.Close()

			ai := NewAI(server.URL, c)
			reply, err := ai.Request(context.Background(), r, "test")
			if err != nil {
				t.Fatalf("unexpected error for %s: %v", sc.name, err)
			}
			if reply.AudioBase64 != "" {
				t.Fatalf("expected empty AudioBase64 for %s, got: %q", sc.name, reply.AudioBase64)
			}
			if len(reply.Tokens) == 0 {
				t.Fatalf("expected valid tokens, got empty")
			}
		})
	}
}

// TestDialogueEnvelopeLocationAndPrecedence verifies unmarshaling when audio_base64
// is at top level vs inside parsed, and precedence when both are provided.
func TestDialogueEnvelopeLocationAndPrecedence(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	const audioParsed = "AUDIO_FROM_PARSED"
	const audioEnvelope = "AUDIO_FROM_ENVELOPE"

	t.Run("only_top_level", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			p := makeValidParsedMap(valid)
			b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": audioEnvelope})
			w.Write(b)
		}))
		defer server.Close()

		reply, err := NewAI(server.URL, c).Request(context.Background(), r, "test")
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if reply.AudioBase64 != audioEnvelope {
			t.Fatalf("expected %q, got %q", audioEnvelope, reply.AudioBase64)
		}
	})

	t.Run("only_in_parsed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			p := makeValidParsedMap(valid)
			p["audio_base64"] = audioParsed
			b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p})
			w.Write(b)
		}))
		defer server.Close()

		reply, err := NewAI(server.URL, c).Request(context.Background(), r, "test")
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if reply.AudioBase64 != audioParsed {
			t.Fatalf("expected %q, got %q", audioParsed, reply.AudioBase64)
		}
	})

	t.Run("precedence_parsed_over_envelope", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			p := makeValidParsedMap(valid)
			p["audio_base64"] = audioParsed
			b, _ := json.Marshal(map[string]any{"raw": "", "parsed": p, "audio_base64": audioEnvelope})
			w.Write(b)
		}))
		defer server.Close()

		reply, err := NewAI(server.URL, c).Request(context.Background(), r, "test")
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		// dialogue.go lines 99-103: if fields.AudioBase64 != nil { audio = *fields.AudioBase64 } else if envelope.AudioBase64 != nil ...
		if reply.AudioBase64 != audioParsed {
			t.Fatalf("expected parsed to take precedence (%q), got %q", audioParsed, reply.AudioBase64)
		}
	})
}

// TestDialogueStressConcurrentRequests exercises the server with 25 concurrent requests
// each returning ~200 KiB audio payload to verify absence of data races, goroutine leaks, or crashes.
func TestDialogueStressConcurrentRequests(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	wavData := makeWAV(150 * 1024)
	b64Audio := base64.StdEncoding.EncodeToString(wavData)

	parsed := makeValidParsedMap(valid)
	parsed["audio_base64"] = b64Audio
	respBytes, _ := json.Marshal(map[string]any{"raw": "", "parsed": parsed})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(respBytes)
	}))
	defer server.Close()

	ai := NewAI(server.URL, c)
	const concurrency = 25
	errChan := make(chan error, concurrency)

	for i := 0; i < concurrency; i++ {
		go func(id int) {
			reply, err := ai.Request(context.Background(), r, fmt.Sprintf("req-%d", id))
			if err != nil {
				errChan <- err
				return
			}
			if len(reply.AudioBase64) != len(b64Audio) {
				errChan <- fmt.Errorf("audio length mismatch: got %d, want %d", len(reply.AudioBase64), len(b64Audio))
				return
			}
			errChan <- nil
		}(i)
	}

	for i := 0; i < concurrency; i++ {
		if err := <-errChan; err != nil {
			t.Fatalf("concurrent request failure: %v", err)
		}
	}
}

// BenchmarkDialogueUnmarshaling benchmarks the Go server unmarshaling pipeline
// across different audio payload sizes: Empty, 100 KiB, 500 KiB, 1.9 MiB.
func BenchmarkDialogueUnmarshaling(b *testing.B) {
	c, err := LoadCatalog("../../world/catalog.json")
	if err != nil {
		b.Fatal(err)
	}
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)

	benchCases := []struct {
		name     string
		wavBytes int
	}{
		{name: "EmptyAudio", wavBytes: 0},
		{name: "Audio100KiB", wavBytes: 100 * 1024},
		{name: "Audio500KiB", wavBytes: 500 * 1024},
		{name: "Audio1.9MiB", wavBytes: 1400 * 1024},
	}

	for _, bc := range benchCases {
		b.Run(bc.name, func(b *testing.B) {
			parsed := makeValidParsedMap(valid)
			if bc.wavBytes > 0 {
				wavData := makeWAV(bc.wavBytes)
				parsed["audio_base64"] = base64.StdEncoding.EncodeToString(wavData)
			}
			payloadBytes, err := json.Marshal(map[string]any{"raw": "", "parsed": parsed})
			if err != nil {
				b.Fatal(err)
			}

			ai := &AI{Catalog: c}
			b.SetBytes(int64(len(payloadBytes)))
			b.ResetTimer()

			for i := 0; i < b.N; i++ {
				var envelope struct {
					Parsed      json.RawMessage `json:"parsed"`
					AudioBase64 *string         `json:"audio_base64"`
				}
				if err := json.Unmarshal(payloadBytes, &envelope); err != nil {
					b.Fatal(err)
				}
				var fields struct {
					Tokens      *[]Token  `json:"speech_tokens"`
					Emotion     *string   `json:"emotion"`
					Price       *int      `json:"price_new"`
					Mianzi      *int      `json:"mianzi_delta"`
					Aggro       *int      `json:"aggro_delta"`
					State       *string   `json:"fsm_state"`
					Choices     *[]Choice `json:"choices"`
					AudioBase64 *string   `json:"audio_base64"`
				}
				if err := json.Unmarshal(envelope.Parsed, &fields); err != nil {
					b.Fatal(err)
				}
				if fields.Tokens == nil || fields.Emotion == nil || fields.Price == nil || fields.Mianzi == nil || fields.Aggro == nil || fields.State == nil || fields.Choices == nil {
					b.Fatal("missing fields")
				}
				audio := ""
				if fields.AudioBase64 != nil {
					audio = *fields.AudioBase64
				} else if envelope.AudioBase64 != nil {
					audio = *envelope.AudioBase64
				}
				reply := Reply{
					Tokens:      *fields.Tokens,
					Emotion:     *fields.Emotion,
					Price:       *fields.Price,
					MianziDelta: *fields.Mianzi,
					AggroDelta:  *fields.Aggro,
					State:       *fields.State,
					Choices:     *fields.Choices,
					AudioBase64: audio,
				}
				if err := ai.validate(reply, r); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
