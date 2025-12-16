.PHONY: build dev clean

# Build the application
build:
	wails build

# Run in development mode
dev:
	wails dev

# Clean build artifacts
clean:
	rm -rf frontend/dist
	rm -rf build/bin

# Install dependencies
deps:
	cd frontend && npm install
	go mod tidy

# Frontend only
frontend-dev:
	cd frontend && npm run dev

# Build frontend only
frontend-build:
	cd frontend && npm run build