package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// getObjectPath returns the full path for an object given its hash.
// It also creates subdirectories based on the hash to avoid too many files in one directory.
// e.g., hash "abcdef..." -> objects/ab/cd/abcdef...
func getObjectPath(casBaseDir, hash string) string {
	if len(hash) < 4 {
		return filepath.Join(casBaseDir, "objects", hash)
	}
	// Use first two and then next two characters of the hash for subdirectories
	return filepath.Join(casBaseDir, "objects", hash[0:2], hash[2:4], hash)
}

// CalculateFileHash reads a file from the given path and returns its SHA-256 hash.
func CalculateFileHash(filePath string) (string, error) {
	return CalculateFileHashWithContext(context.Background(), filePath)
}

// CalculateFileHashWithContext reads a file from the given path and returns its SHA-256 hash, with context cancellation support.
func CalculateFileHashWithContext(ctx context.Context, filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file %s: %w", filePath, err)
	}
	defer file.Close()

	hash := sha256.New()
	
	// Use a context-aware copier that checks for cancellation
	if _, err := copyWithContext(ctx, hash, file); err != nil {
		return "", fmt.Errorf("failed to calculate hash for file %s: %w", filePath, err)
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

// StoreFileContent stores the content of a file from the given filePath into the CAS system.
// It calculates the hash of the file and stores it if it doesn't already exist.
// Returns the hash of the stored content and an error if any.
// casBaseDir is the root directory where the CAS structure (e.g., "objects") will be created.
func StoreFileContent(casBaseDir string, filePath string) (string, error) {
	return StoreFileContentWithContext(context.Background(), casBaseDir, filePath)
}

// StoreFileContentWithContext stores the content of a file from the given filePath into the CAS system with context cancellation support.
func StoreFileContentWithContext(ctx context.Context, casBaseDir string, filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file %s: %w", filePath, err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := copyWithContext(ctx, hash, file); err != nil {
		return "", fmt.Errorf("failed to calculate hash for file %s: %w", filePath, err)
	}
	fileHash := hex.EncodeToString(hash.Sum(nil))

	// Check for context cancellation before creating directories
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}

	objectPath := getObjectPath(casBaseDir, fileHash)

	// Create parent directories if they don't exist
	if err := os.MkdirAll(filepath.Dir(objectPath), 0755); err != nil {
		return "", fmt.Errorf("failed to create parent directories for object %s: %w", objectPath, err)
	}

	// Check if object already exists
	if _, err := os.Stat(objectPath); err == nil {
		// Object already exists, no need to copy
		return fileHash, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("failed to check existence of object %s: %w", objectPath, err)
	}

	// Check for context cancellation before copying
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}

	// Object does not exist, so copy the file content
	// Re-open the file or seek to the beginning if it was already read
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", fmt.Errorf("failed to seek file %s to start: %w", filePath, err)
	}

	destinationFile, err := os.Create(objectPath)
	if err != nil {
		return "", fmt.Errorf("failed to create object file %s: %w", objectPath, err)
	}
	defer destinationFile.Close()

	if _, err := copyWithContext(ctx, destinationFile, file); err != nil {
		return "", fmt.Errorf("failed to copy content to object file %s: %w", objectPath, err)
	}

	return fileHash, nil
}

// copyWithContext copies data from src to dst while checking for context cancellation.
// It uses a buffer size that balances performance with cancellation responsiveness.
func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, 32*1024) // 32KB buffer - good balance between performance and responsiveness
	var written int64
	
	for {
		// Check for cancellation before each read
		select {
		case <-ctx.Done():
			return written, ctx.Err()
		default:
		}
		
		nr, err := src.Read(buf)
		if nr > 0 {
			// Check for cancellation before each write
			select {
			case <-ctx.Done():
				return written, ctx.Err()
			default:
			}
			
			nw, err := dst.Write(buf[0:nr])
			if nw < 0 || nr < nw {
				nw = 0
				if err == nil {
					err = fmt.Errorf("invalid write result")
				}
			}
			written += int64(nw)
			if err != nil {
				return written, err
			}
			if nr != nw {
				return written, io.ErrShortWrite
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return written, err
		}
	}
	return written, nil
}

// RetrieveObject reads the content of an object given its hash from the CAS system.
// It returns an io.ReadCloser for the object's content.
func RetrieveObject(casBaseDir, hash string) (io.ReadCloser, error) {
	objectPath := getObjectPath(casBaseDir, hash)
	file, err := os.Open(objectPath)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve object %s: %w", hash, err)
	}
	return file, nil
}
