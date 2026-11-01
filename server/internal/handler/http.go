package handler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/hub"
)

type App struct {
	Store     *db.Store
	Hub       *hub.Hub
	Catalog   *game.Catalog
	secret    []byte
	origins   map[string]bool
	dummyHash []byte
}

func New(s *db.Store, h *hub.Hub, c *game.Catalog, secret string, origins []string) (*App, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must contain at least 32 bytes")
	}
	a := &App{Store: s, Hub: h, Catalog: c, secret: []byte(secret), origins: map[string]bool{}}
	for _, o := range origins {
		o = strings.TrimSpace(o)
		u, err := url.Parse(o)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return nil, fmt.Errorf("invalid allowed origin %q", o)
		}
		a.origins[o] = true
	}
	if len(a.origins) == 0 {
		return nil, fmt.Errorf("ALLOWED_ORIGINS must not be empty")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("invalid-account-password"), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	a.dummyHash = hash
	return a, nil
}
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("POST /auth/register", a.register)
	mux.HandleFunc("POST /auth/login", a.login)
	mux.HandleFunc("GET /ws", a.ws)
	mux.HandleFunc("GET /world/chunks", a.worldChunks)
	mux.HandleFunc("POST /world/chunks", a.worldChunks)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Add("Vary", "Origin")
			if !a.origins[origin] {
				failure(w, 403, "ORIGIN_DENIED")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]string{"error": code})
}

type credentials struct {
	Login    string `json:"login"`
	Password string `json:"password"`
	Profile  string `json:"profile,omitempty"`
}

func readCredentials(w http.ResponseWriter, r *http.Request) (credentials, bool) {
	var c credentials
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || hub.Decode(b, &c) != nil {
		failure(w, 400, "INVALID_REQUEST")
		return c, false
	}
	c.Login = strings.TrimSpace(c.Login)
	if utf8.RuneCountInString(c.Login) < 3 || utf8.RuneCountInString(c.Login) > 32 || len(c.Password) < 8 || len(c.Password) > 72 {
		failure(w, 400, "INVALID_CREDENTIALS")
		return c, false
	}
	return c, true
}
func (a *App) register(w http.ResponseWriter, r *http.Request) {
	c, ok := readCredentials(w, r)
	if !ok {
		return
	}
	if c.Profile == "" {
		c.Profile = "business"
	}
	words, ok := a.Catalog.Profiles[c.Profile]
	if !ok {
		failure(w, 400, "INVALID_PROFILE")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		failure(w, 500, "AUTH_ERROR")
		return
	}
	p, err := a.Store.Register(r.Context(), c.Login, string(hash), c.Profile, words)
	if errors.Is(err, db.ErrLoginTaken) {
		failure(w, 409, "LOGIN_TAKEN")
		return
	}
	if err != nil {
		failure(w, 500, "DB_ERROR")
		return
	}
	a.authResponse(w, r, p, 201)
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	c, ok := readCredentials(w, r)
	if !ok {
		return
	}
	p, err := a.Store.ByLogin(r.Context(), c.Login)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		failure(w, 500, "DB_ERROR")
		return
	}
	hash := []byte(p.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		hash = a.dummyHash
	}
	passwordErr := bcrypt.CompareHashAndPassword(hash, []byte(c.Password))
	if err != nil || passwordErr != nil {
		failure(w, 401, "INVALID_CREDENTIALS")
		return
	}
	a.authResponse(w, r, p, 200)
}
func (a *App) authResponse(w http.ResponseWriter, r *http.Request, p db.Player, status int) {
	words, err := a.Store.Words(r.Context(), p.ID)
	if err != nil {
		failure(w, 500, "DB_ERROR")
		return
	}
	inventory, err := a.Store.Inventory(r.Context(), p.ID)
	if err != nil {
		failure(w, 500, "DB_ERROR")
		return
	}
	expires := time.Now().Add(8 * time.Hour)
	token, err := a.Token(p.ID, expires)
	if err != nil {
		failure(w, 500, "AUTH_ERROR")
		return
	}
	respond(w, status, map[string]any{"token": token, "expires_at": expires.UTC().Format(time.RFC3339), "player": p, "known_words": words, "inventory": inventory})
}
func (a *App) Token(id int64, expires time.Time) (string, error) {
	claims := jwt.RegisteredClaims{Subject: strconv.FormatInt(id, 10), Issuer: "hackaton/server", IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(expires)}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.secret)
}
func (a *App) worldChunks(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) { return a.secret, nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("hackaton/server"), jwt.WithExpirationRequired())
	id, parseErr := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || parseErr != nil || id < 1 {
		failure(w, 401, "INVALID_TOKEN")
		return
	}
	if _, err = a.Store.Player(r.Context(), id); err != nil {
		failure(w, 401, "INVALID_TOKEN")
		return
	}
	var updates map[string]db.WorldChunk
	if r.Method == http.MethodPost {
		body, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		var payload struct {
			Chunks map[string]db.WorldChunk `json:"chunks"`
		}
		if readErr != nil || hub.Decode(body, &payload) != nil || len(payload.Chunks) == 0 || len(payload.Chunks) > 100 {
			failure(w, 400, "INVALID_WORLD_EDIT")
			return
		}
		updates = payload.Chunks
	}
	chunks, err := a.Hub.World(r.Context(), updates)
	if errors.Is(err, db.ErrWorldConflict) {
		failure(w, 409, "WORLD_CONFLICT")
		return
	}
	if err != nil {
		if updates != nil {
			failure(w, 400, "WORLD_SAVE_FAILED")
		} else {
			failure(w, 500, "DB_ERROR")
		}
		return
	}
	respond(w, 200, map[string]any{"chunks": chunks})
}
func (a *App) ws(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("token")
	if raw == "" {
		raw = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) { return a.secret, nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("hackaton/server"), jwt.WithExpirationRequired())
	if err != nil {
		failure(w, 401, "INVALID_TOKEN")
		return
	}
	id, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || id < 1 {
		failure(w, 401, "INVALID_TOKEN")
		return
	}
	if _, err = a.Store.Player(r.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			failure(w, 401, "INVALID_TOKEN")
		} else {
			failure(w, 500, "DB_ERROR")
		}
		return
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, HandshakeTimeout: 5 * time.Second, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" || a.origins[r.Header.Get("Origin")] }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	a.Hub.Attach(conn, id, claims.ExpiresAt.Time)
}
func (a *App) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.Store.SQL.PingContext(ctx); err != nil {
		failure(w, 503, "DB_UNAVAILABLE")
		return
	}
	respond(w, 200, map[string]any{"status": "ok", "db": "ok", "total_chunks": 100})
}
