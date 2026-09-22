FROM golang:1.27.1-bookworm

WORKDIR /app
COPY worker/go.mod ./worker/
COPY worker ./worker

WORKDIR /app/worker
RUN go build -o /usr/local/bin/kplus-worker ./cmd/worker

ENTRYPOINT ["/usr/local/bin/kplus-worker"]
