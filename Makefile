PI_BINARY := packages/coding-agent/dist/pi
ASYNC_EXTENSION := $(CURDIR)/packages/async-pi-extension

.PHONY: pi

pi:
	npm run build:offline
	npm --prefix packages/coding-agent run build:binary
	./$(PI_BINARY) install "$(ASYNC_EXTENSION)"
