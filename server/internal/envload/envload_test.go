package envload

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		line  string
		key   string
		value string
		ok    bool
	}{
		{"JWT_SECRET=abc", "JWT_SECRET", "abc", true},
		{"  DATABASE_URL = postgres://x  ", "DATABASE_URL", "postgres://x", true},
		{"export FOO=bar", "FOO", "bar", true},
		{`QUOTED="a b"`, "QUOTED", "a b", true},
		{"# comment", "", "", false},
		{"", "", "", false},
		{"NO_EQUALS", "", "", false},
	}
	for _, c := range cases {
		key, value, ok := parse(c.line)
		if key != c.key || value != c.value || ok != c.ok {
			t.Errorf("parse(%q) = (%q, %q, %v), want (%q, %q, %v)", c.line, key, value, ok, c.key, c.value, c.ok)
		}
	}
}

func TestLoadFileDoesNotOverrideExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("EXISTING=from_file\nMISSING=from_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EXISTING", "from_env")
	os.Unsetenv("MISSING")
	t.Cleanup(func() { os.Unsetenv("MISSING") })
	if err := loadFile(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("EXISTING"); got != "from_env" {
		t.Errorf("EXISTING = %q, want from_env", got)
	}
	if got := os.Getenv("MISSING"); got != "from_file" {
		t.Errorf("MISSING = %q, want from_file", got)
	}
}
