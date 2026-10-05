.PHONY: all build test clean run run-server

BINARY_NAME=go-scraper
BINARY_PATH=bin/$(BINARY_NAME)
SERVER_PATH=bin/scraper-server

all: build test

build:
	go build -o $(BINARY_PATH) ./cmd/scraper
	go build -o $(SERVER_PATH) ./cmd/server

# HTTP service used by the Tavily search API (packages/app)
run-server:
	go run ./cmd/server

test:
	go test -v ./...

bench:
	go test -bench=. ./...

clean:
	rm -rf bin/ output/
