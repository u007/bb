package backend

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// BackupProgress represents the progress of a backup operation
type BackupProgress struct {
	TotalFiles       int    `json:"totalFiles"`
	FilesProcessed   int    `json:"filesProcessed"`
	CurrentFile      string `json:"currentFile"`
	BytesTransferred int64  `json:"bytesTransferred"`
	TotalBytes       int64  `json:"totalBytes"`
	Status           string `json:"status"` // e.g., "Scanning", "Hashing", "Storing", "Completed", "Failed"
	Error            string `json:"error"`
}

// ProgressCallback is a function type for reporting backup progress.
type ProgressCallback func(progress BackupProgress)

// shouldIgnore checks if a file or directory should be ignored based on patterns
func shouldIgnore(path string, d fs.DirEntry, ignorePatterns []string) bool {
	for _, pattern := range ignorePatterns {
		if pattern == "" {
			continue
		}

		// Handle different pattern types
		if shouldIgnorePattern(path, d.Name(), pattern) {
			return true
		}
	}
	return false
}

// ShouldIgnore is a public wrapper for testing ignore patterns without a DirEntry
func ShouldIgnore(path string, ignorePatterns []string) bool {
	// Create a mock DirEntry for testing
	mockEntry := &mockDirEntry{name: filepath.Base(path), isDir: false}
	return shouldIgnore(path, mockEntry, ignorePatterns)
}

// mockDirEntry implements fs.DirEntry for testing
type mockDirEntry struct {
	name  string
	isDir bool
}

func (m *mockDirEntry) Name() string               { return m.name }
func (m *mockDirEntry) IsDir() bool              { return m.isDir }
func (m *mockDirEntry) Type() fs.FileMode        { return 0 }
func (m *mockDirEntry) Info() (fs.FileInfo, error) { return nil, nil }

// shouldIgnorePattern checks if a path matches a single ignore pattern
func shouldIgnorePattern(fullPath, fileName, pattern string) bool {
	// Convert path separators to forward slashes for consistent matching
	normalizedPath := filepath.ToSlash(fullPath)
	normalizedPattern := filepath.ToSlash(pattern)

	// Absolute path match
	if filepath.IsAbs(pattern) && normalizedPath == normalizedPattern {
		return true
	}

	// Directory-specific patterns (ending with /)
	if strings.HasSuffix(normalizedPattern, "/") {
		dirPattern := strings.TrimSuffix(normalizedPattern, "/")
		// Check if path is exactly this directory or a subdirectory of it
		if normalizedPath == dirPattern || strings.HasPrefix(normalizedPath, dirPattern+"/") {
			return true
		}
	}

	// Filename pattern match
	if matched, _ := filepath.Match(pattern, fileName); matched {
		return true
	}

	// Check if any part of the path matches the pattern (for patterns like *.tmp)
	pathParts := strings.Split(normalizedPath, "/")
	for _, part := range pathParts {
		if matched, _ := filepath.Match(pattern, part); matched {
			return true
		}
	}

	// Relative path pattern match against full path
	if matched, _ := filepath.Match(pattern, normalizedPath); matched {
		return true
	}

	// Enhanced path-based matching for patterns with slashes
	if strings.Contains(normalizedPattern, "/") {
		// Try to match directory patterns like "src/*.go"
		if matched, _ := filepath.Match(normalizedPattern, normalizedPath); matched {
			return true
		}
		if matched, _ := filepath.Match(normalizedPattern+"/*", normalizedPath); matched {
			return true
		}
		if matched, _ := filepath.Match("*/"+normalizedPattern, normalizedPath); matched {
			return true
		}
		if matched, _ := filepath.Match("*"+normalizedPattern+"*", normalizedPath); matched {
			return true
		}
	}

	// Substring matching for patterns like ".pnpm-store"
	if strings.Contains(normalizedPath, pattern) {
		return true
	}

	// Simple wildcard matching
	if matched, _ := filepath.Match("*"+pattern, normalizedPath); matched {
		return true
	}
	if matched, _ := filepath.Match(pattern+"*", normalizedPath); matched {
		return true
	}
	if matched, _ := filepath.Match("*"+pattern+"*", normalizedPath); matched {
		return true
	}

	return false
}

// RunBackup orchestrates the entire backup process for specified source paths to a CAS base directory.
// It reports progress via the provided ProgressCallback.
func RunBackup(ctx context.Context, casBaseDir string, sourcePaths []string, ignorePatterns []string, progressCallback ProgressCallback) error {
	return RunBackupWithBatchConfig(ctx, casBaseDir, sourcePaths, ignorePatterns, progressCallback, DefaultBatchConfig())
}

// RunBackupWithBatchConfig orchestrates the entire backup process with custom batch configuration.
func RunBackupWithBatchConfig(ctx context.Context, casBaseDir string, sourcePaths []string, ignorePatterns []string, progressCallback ProgressCallback, config BatchConfig) error {
	var currentProgress BackupProgress
	updateProgress := func() {
		if progressCallback != nil {
			progressCallback(currentProgress)
		}
	}

	currentProgress.Status = "Initializing"
	updateProgress()

	// Log ignore patterns for debugging
	if len(ignorePatterns) > 0 {
		fmt.Fprintf(os.Stderr, "DEBUG: Using %d ignore patterns: %v\n", len(ignorePatterns), ignorePatterns)
	} else {
		fmt.Fprintf(os.Stderr, "DEBUG: No ignore patterns specified\n")
	}

	// Check for context cancellation early
	select {
	case <-ctx.Done():
		currentProgress.Status = "Cancelled"
		currentProgress.Error = "Backup cancelled during initialization"
		updateProgress()
		return ctx.Err()
	default:
	}

	// 1. Load the latest snapshot
	currentProgress.Status = "Loading previous snapshot..."
	updateProgress()

	fmt.Fprintf(os.Stderr, "DEBUG: About to load latest snapshot from %s\n", casBaseDir)
	latestSnapshot, err := LoadLatestSnapshot(casBaseDir)
	fmt.Fprintf(os.Stderr, "DEBUG: LoadLatestSnapshot returned: err=%v, snapshot=%p\n", err, latestSnapshot)
	if err != nil {
		// If snapshot loading fails, log warning but continue with no previous snapshot
		fmt.Fprintf(os.Stderr, "Warning: Failed to load latest snapshot, starting fresh backup: %v\n", err)
		latestSnapshot = nil
		currentProgress.Status = "Warning: Could not load previous snapshot, starting fresh"
		updateProgress()
	}

	fmt.Fprintf(os.Stderr, "DEBUG: Creating streaming snapshot writer\n")
	snapshotID := fmt.Sprintf("%d", time.Now().Unix())
	snapshotWriter, err := NewStreamingSnapshotWriter(casBaseDir, snapshotID, sourcePaths)
	if err != nil {
		currentProgress.Status = "Failed"
		currentProgress.Error = fmt.Sprintf("Failed to create snapshot writer: %v", err)
		updateProgress()
		return fmt.Errorf("failed to create snapshot writer: %w", err)
	}
	defer snapshotWriter.Close()
	fmt.Fprintf(os.Stderr, "DEBUG: Streaming snapshot writer created, about to start file processing\n")

	fileCount := 0
	batchCount := 0
	lastFlushTime := time.Now()
	// First pass: count files and estimate total size (optional, for more accurate progress)
	// For simplicity, we'll iterate and count on the fly for now.
	// A more robust solution might do a pre-scan to get TotalFiles and TotalBytes.

	// For each source path, walk through files and process them
	fmt.Fprintf(os.Stderr, "DEBUG: Starting to process %d source paths\n", len(sourcePaths))
	for i, sourcePath := range sourcePaths {
		// Check for context cancellation before starting each source path
		select {
		case <-ctx.Done():
			currentProgress.Status = "Cancelled"
			currentProgress.Error = "Backup cancelled by user before processing " + sourcePath
			updateProgress()
			return ctx.Err()
		default:
			// Continue
		}

		fmt.Fprintf(os.Stderr, "DEBUG: Processing source path %d: %s\n", i, sourcePath)
		absSourcePath, err := filepath.Abs(sourcePath)
		if err != nil {
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Failed to get absolute path for source %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("failed to get absolute path for source %s: %w", sourcePath, err)
		}
		fmt.Fprintf(os.Stderr, "DEBUG: Absolute path: %s\n", absSourcePath)

		currentProgress.Status = fmt.Sprintf("Scanning %s...", filepath.Base(sourcePath))
		updateProgress()

		fmt.Fprintf(os.Stderr, "DEBUG: About to start WalkDir\n")
		filesWalked := 0
		err = filepath.WalkDir(absSourcePath, func(path string, d fs.DirEntry, err error) error {
			// Check for context cancellation more frequently (every file)
			select {
			case <-ctx.Done():
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user during file scanning"
				updateProgress()
				return ctx.Err() // Propagate cancellation error
			default:
				// Continue
			}

			filesWalked++
			if filesWalked%10 == 0 {
				fmt.Fprintf(os.Stderr, "DEBUG: WalkDir has processed %d files, current path: %s\n", filesWalked, path)

				// Additional context check every 10 files
				select {
				case <-ctx.Done():
					currentProgress.Status = "Cancelled"
					currentProgress.Error = "Backup cancelled by user during file scanning"
					updateProgress()
					return ctx.Err()
				default:
					// Continue
				}
			}

			// Memory management and batch processing
			if fileCount%100 == 0 {
				// Give other goroutines a chance to run every 100 files
				runtime.Gosched()

				// Check memory usage
				memStats := GetMemoryStats()
				if memStats.Alloc > uint64(config.MemoryLimit) {
					fmt.Fprintf(os.Stderr, "DEBUG: Memory limit reached (%d > %d), forcing GC\n", memStats.Alloc, config.MemoryLimit)
					runtime.GC()
					runtime.Gosched()
				}
			}

			if err != nil {
				// Log error but attempt to continue for other files if possible
				currentProgress.Status = "Scanning (with errors)"
				currentProgress.Error = fmt.Sprintf("Error accessing %s: %v", path, err)
				updateProgress()
				return nil // Don't return error here to allow WalkDir to continue
			}

			// --- IGNORE LOGIC ---
			if shouldIgnore(path, d, ignorePatterns) {
				fmt.Fprintf(os.Stderr, "DEBUG: Ignoring %s\n", path)
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil // Skip this file
			} else {
				// fmt.Fprintf(os.Stderr, "DEBUG: Processing %s (no pattern matched)\n", path)
			}

			// Exclude the backup destination directory itself
			// This check assumes casBaseDir is an absolute path.
			// It's crucial that casBaseDir is passed as an absolute path from the frontend.
			if strings.HasPrefix(path, casBaseDir) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			if d.IsDir() {
				return nil // Skip directories after ignore checks
			}

			// Get relative path from the source root
			relPath, err := filepath.Rel(absSourcePath, path)
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get relative path for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get relative path for %s: %w", path, err)
			}
			// Use forward slashes for consistency regardless of OS
			relPath = filepath.ToSlash(relPath)

			fileInfo, err := d.Info()
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get file info for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get file info for %s: %w", path, err)
			}

			fileCount++
			currentProgress.TotalFiles = fileCount // Update total files found so far
			currentProgress.FilesProcessed++
			currentProgress.CurrentFile = path
			currentProgress.Status = "Processing file"
			updateProgress()

			// Check for context cancellation before heavy file operations
			select {
			case <-ctx.Done():
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user during file processing"
				updateProgress()
				return ctx.Err()
			default:
				// Continue
			}

			currentFileEntry := &FileEntry{
				Path:    relPath,
				Size:    fileInfo.Size(),
				Mode:    fileInfo.Mode(),
				ModTime: fileInfo.ModTime(),
			}

			// Compare with latest snapshot - rsync-like optimization
			var fileHash string
			var fileChanged bool

			if latestSnapshot != nil {
				if prevEntry, ok := latestSnapshot.Files[relPath]; ok {
					// Quick check: size and mtime match means file is unchanged
					if prevEntry.Size == currentFileEntry.Size &&
						prevEntry.ModTime.Equal(currentFileEntry.ModTime) {
						fileHash = prevEntry.Hash
					} else {
						fileChanged = true
					}
				} else {
					fileChanged = true // New file
				}
			} else {
				fileChanged = true // First backup
			}

			if fileChanged {
				currentProgress.Status = "↻ " + filepath.Base(path) // Changed file indicator
				updateProgress()

				// Additional context check before starting file I/O
				select {
				case <-ctx.Done():
					currentProgress.Status = "Cancelled"
					currentProgress.Error = "Backup cancelled by user before file storage"
					updateProgress()
					return ctx.Err()
				default:
					// Continue
				}

				hash, err := StoreFileContentWithContext(ctx, casBaseDir, path)
				if err != nil {
					if err == context.Canceled {
						currentProgress.Status = "Cancelled"
						currentProgress.Error = "Backup cancelled by user during file storage"
						updateProgress()
						return ctx.Err()
					}
					currentProgress.Status = "✗ Failed"
					currentProgress.Error = fmt.Sprintf("Failed to store content for %s: %v", path, err)
					updateProgress()
					return fmt.Errorf("failed to store content for %s: %w", path, err)
				}
				fileHash = hash

				// Check context again after file storage
				select {
				case <-ctx.Done():
					currentProgress.Status = "Cancelled"
					currentProgress.Error = "Backup cancelled by user after file storage"
					updateProgress()
					return ctx.Err()
				default:
					// Continue
				}
			} else {
				currentProgress.Status = "= " + filepath.Base(path) // Unchanged file indicator
				currentProgress.FilesProcessed-- // Don't count as processed for progress
				updateProgress()
			}
			currentFileEntry.Hash = fileHash

			// Add to streaming snapshot writer with batch processing
			if err := snapshotWriter.AddFile(currentFileEntry); err != nil {
				currentProgress.Status = "✗ Failed"
				currentProgress.Error = fmt.Sprintf("Failed to add file to snapshot: %v", err)
				updateProgress()
				return fmt.Errorf("failed to add file to snapshot: %w", err)
			}

			batchCount++

			// Batch processing: flush based on count or time
			timeSinceFlush := time.Since(lastFlushTime)
			if batchCount >= config.BatchSize || timeSinceFlush >= config.FlushInterval {
				// Check for context cancellation before I/O heavy flush operation
				select {
				case <-ctx.Done():
					currentProgress.Status = "Cancelled"
					currentProgress.Error = "Backup cancelled by user during batch flush"
					updateProgress()
					return ctx.Err()
				default:
					// Continue
				}

				fmt.Fprintf(os.Stderr, "DEBUG: Flushing batch (count: %d, time: %v)\n", batchCount, timeSinceFlush)
				if err := snapshotWriter.writer.Flush(); err != nil {
					currentProgress.Status = "✗ Failed"
					currentProgress.Error = fmt.Sprintf("Failed to flush snapshot writer: %v", err)
					updateProgress()
					return fmt.Errorf("failed to flush snapshot writer: %w", err)
				}
				batchCount = 0
				lastFlushTime = time.Now()

				// Force garbage collection to free memory
				runtime.GC()

				// Check context again after heavy I/O operation
				select {
				case <-ctx.Done():
					currentProgress.Status = "Cancelled"
					currentProgress.Error = "Backup cancelled by user after batch flush"
					updateProgress()
					return ctx.Err()
				default:
					// Continue
				}
			}

			// Only count bytes for files that were actually transferred
			if fileChanged {
				currentProgress.BytesTransferred += fileInfo.Size()
			}
			updateProgress()

			return nil
		})
		if err != nil {
			if err == context.Canceled { // Check if the error was due to context cancellation
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user"
				updateProgress()
				return err // Propagate cancellation error
			}
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Error walking source path %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("error walking source path %s: %w", sourcePath, err)
		}
	}

	// Check for context cancellation before final operations
	select {
	case <-ctx.Done():
		currentProgress.Status = "Cancelled"
		currentProgress.Error = "Backup cancelled by user during finalization"
		updateProgress()
		return ctx.Err()
	default:
		// Continue
	}

	// Final flush and close of streaming snapshot writer
	fmt.Fprintf(os.Stderr, "DEBUG: Final flush and close of streaming snapshot writer\n")
	if batchCount > 0 {
		// Check for context cancellation before final flush
		select {
		case <-ctx.Done():
			currentProgress.Status = "Cancelled"
			currentProgress.Error = "Backup cancelled by user during final flush"
			updateProgress()
			return ctx.Err()
		default:
			// Continue
		}

		if err := snapshotWriter.writer.Flush(); err != nil {
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Failed to flush final batch: %v", err)
			updateProgress()
			return fmt.Errorf("failed to flush final batch: %w", err)
		}
	}

	currentProgress.Status = "Finalizing snapshot..."
	updateProgress()

	// Check for context cancellation before close
	select {
	case <-ctx.Done():
		currentProgress.Status = "Cancelled"
		currentProgress.Error = "Backup cancelled by user during snapshot finalization"
		updateProgress()
		return ctx.Err()
	default:
		// Continue
	}

	// Close the streaming snapshot writer (this finalizes the snapshot)
	if err := snapshotWriter.Close(); err != nil {
		currentProgress.Status = "Failed"
		currentProgress.Error = fmt.Sprintf("Failed to close snapshot writer: %v", err)
		updateProgress()
		return fmt.Errorf("failed to close snapshot writer: %w", err)
	}

	// Load the final snapshot to get statistics (optional, for logging only)
	_, err = LoadLatestSnapshot(casBaseDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to load final snapshot for stats: %v\n", err)
	}

	totalFiles := fileCount
	changedFiles := currentProgress.FilesProcessed // Approximate since we're streaming

	currentProgress.Status = fmt.Sprintf("✓ Completed: %d files, %d processed, %.2f MB transferred",
		totalFiles, changedFiles, float64(currentProgress.BytesTransferred)/1024/1024)
	updateProgress()

	// Final memory cleanup
	runtime.GC()
	fmt.Fprintf(os.Stderr, "DEBUG: Backup completed successfully\n")
	return nil
}
