GO ?= go
BINARY := teamsmonkey

.PHONY: all build fmt test vet check clean install uninstall

all: check build

build:
	$(GO) build -o $(BINARY) .

fmt:
	$(GO)fmt -w main.go

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

check: fmt test vet
	git diff --check

clean:
	rm -f $(BINARY)

install: build
	./$(BINARY) --service-install

uninstall: build
	./$(BINARY) --service-uninstall
