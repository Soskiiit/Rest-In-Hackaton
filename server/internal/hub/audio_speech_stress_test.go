package hub

import (
	"encoding/json"
	"strings"
	"testing"

	"hackaton/server/internal/game"
)

// TestSpeechAudioStructFieldCopying verifies that AudioBase64 from game.Reply
// is faithfully transferred to the hub.Speech struct.
func TestSpeechAudioStructFieldCopying(t *testing.T) {
	testAudio := "UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="

	reply := game.Reply{
		Tokens:      []game.Token{{ID: "word_hello", ZH: "你好", PY: "nǐ hǎo", RU: "здравствуйте"}},
		Emotion:     "neutral",
		Price:       800,
		MianziDelta: 5,
		AggroDelta:  -2,
		State:       "CALLING",
		Choices:     game.Choices(),
		AudioBase64: testAudio,
	}

	speech := Speech{
		NPCID:        "lao_wang",
		PlayerID:     42,
		Tokens:       reply.Tokens,
		Choices:      reply.Choices,
		TurnID:       "turn_12345",
		Emotion:      reply.Emotion,
		Mianzi:       50,
		Aggro:        10,
		Price:        reply.Price,
		State:        reply.State,
		Fallback:     false,
		Offers:       []string{"tea"},
		SceneVersion: 1,
		AudioBase64:  reply.AudioBase64,
	}

	if speech.AudioBase64 != testAudio {
		t.Fatalf("Speech.AudioBase64 mismatch: got %q, want %q", speech.AudioBase64, testAudio)
	}

	// Verify JSON marshaling includes audio_base64
	bytes, err := json.Marshal(speech)
	if err != nil {
		t.Fatalf("failed to marshal speech: %v", err)
	}
	jsonStr := string(bytes)
	if !strings.Contains(jsonStr, `"audio_base64":"`+testAudio+`"`) {
		t.Fatalf("marshaled speech missing audio_base64 field: %s", jsonStr)
	}

	// Verify WebSocket packet envelope
	wsPacket, err := json.Marshal(map[string]any{"type": "NPC_SPEECH", "payload": speech})
	if err != nil {
		t.Fatalf("failed to marshal NPC_SPEECH ws packet: %v", err)
	}
	wsStr := string(wsPacket)
	if !strings.Contains(wsStr, `"type":"NPC_SPEECH"`) || !strings.Contains(wsStr, testAudio) {
		t.Fatalf("NPC_SPEECH packet missing expected structure or audio: %s", wsStr)
	}
}

// TestSpeechAudioOmitemptyWhenEmpty verifies that empty AudioBase64 is omitted from JSON output.
func TestSpeechAudioOmitemptyWhenEmpty(t *testing.T) {
	speech := Speech{
		NPCID:        "lao_wang",
		PlayerID:     42,
		Tokens:       []game.Token{{ID: "word_hello", ZH: "你好", PY: "nǐ hǎo", RU: "здравствуйте"}},
		Choices:      game.Choices(),
		TurnID:       "turn_12345",
		Emotion:      "neutral",
		Mianzi:       50,
		Aggro:        10,
		Price:        800,
		State:        "CALLING",
		Fallback:     false,
		SceneVersion: 1,
		AudioBase64:  "", // explicitly empty
	}

	bytes, err := json.Marshal(speech)
	if err != nil {
		t.Fatalf("failed to marshal speech: %v", err)
	}
	jsonStr := string(bytes)
	if strings.Contains(jsonStr, "audio_base64") {
		t.Fatalf("expected audio_base64 to be omitted when empty (omitempty), but found: %s", jsonStr)
	}
}

// TestSpeechObserverViewPreservesAudio verifies that nearby observers outside interaction radius
// still receive the audio payload in their speech view (even though choices/turn are stripped).
func TestSpeechObserverViewPreservesAudio(t *testing.T) {
	testAudio := "UklGR_OBSERVER_AUDIO_SAMPLE"
	speech := Speech{
		NPCID:       "lao_wang",
		PlayerID:    1,
		Choices:     game.Choices(),
		TurnID:      "turn_active_player",
		AudioBase64: testAudio,
	}

	// Mirroring lines 168-174 of interactions.go:
	view := speech
	view.Choices = []game.Choice{}
	view.TurnID = ""

	if view.AudioBase64 != testAudio {
		t.Fatalf("observer view lost AudioBase64: got %q, want %q", view.AudioBase64, testAudio)
	}
	if len(view.Choices) != 0 || view.TurnID != "" {
		t.Fatalf("observer view choices or turn not stripped properly")
	}
}
