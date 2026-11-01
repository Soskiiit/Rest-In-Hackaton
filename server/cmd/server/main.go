package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/handler"
	"hackaton/server/internal/hub"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
func run() error {
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		return fmt.Errorf("set JWT_SECRET to at least 32 random characters")
	}
	catalog, err := game.LoadCatalog(env("CATALOG_PATH", "world/catalog.json"))
	if err != nil {
		return err
	}
	store, err := db.Open(os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer store.Close()
	worldDir := env("WORLD_DIR", "world/chunks")
	stored, err := store.LoadWorld(context.Background(), nil)
	if errors.Is(err, db.ErrWorldUninitialized) {
		initial, loadErr := game.LoadWorld(worldDir, catalog)
		if loadErr != nil {
			return loadErr
		}
		seed := make(map[string]json.RawMessage, len(initial.Chunks))
		for id, chunk := range initial.Chunks {
			raw, marshalErr := json.Marshal(chunk)
			if marshalErr != nil {
				return marshalErr
			}
			seed[id] = raw
		}
		stored, err = store.LoadWorld(context.Background(), seed)
	}
	if err != nil {
		return err
	}
	data := make(map[string]json.RawMessage, len(stored))
	for id, chunk := range stored {
		data[id] = chunk.Data
	}
	world, err := game.LoadWorldData(worldDir, data, catalog)
	if err != nil {
		return err
	}
	for id, chunk := range stored {
		world.Revisions[id] = chunk.Revision
	}
	h := hub.New(store, world, catalog, game.NewAI(env("AI_URL", "http://127.0.0.1:8000"), catalog))
	defer h.Close()
	app, err := handler.New(store, h, catalog, secret, strings.Split(env("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"), ","))
	if err != nil {
		return err
	}
	srv := &http.Server{Addr: env("SERVER_ADDR", ":3000"), Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	listener, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return err
	}
	signals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errors := make(chan error, 1)
	go func() { errors <- srv.Serve(listener) }()
	log.Printf("server listening on %s, world=%d chunks/%d bytes", listener.Addr(), len(world.Chunks), world.TotalBytes)
	select {
	case err := <-errors:
		if err != http.ErrServerClosed {
			return err
		}
	case <-signals.Done():
	}
	h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
