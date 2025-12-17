package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// createTestFiles creates a specified number of test files with content
func createTestFiles(t *testing.T, baseDir string, numFiles int) {
	t.Helper()
	
	for i := 0; i < numFiles; i++ {
		dirPath := filepath.Join(baseDir, fmt.Sprintf("dir%d", i/100))
		os.MkdirAll(dirPath, 0755)
		
		filePath := filepath.Join(dirPath, fmt.Sprintf("file%d.txt", i))
		content := fmt.Sprintf("Test file content %d with some repeated text to make it a bit longer. %s", 
			i, strings.Repeat("x", 100))
		
		err := os.WriteFile(filePath, []byte(content), 0644)
		if err != nil {
			t.Fatalf("Failed to create test file %s: %v", filePath, err)
		}
	}
}

// getMemoryUsage returns current memory usage in MB
func getMemoryUsage() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.Alloc) / 1024 / 1024
}

// TestMemoryEfficientBackup tests the memory-efficient backup functionality
func TestMemoryEfficientBackup(t *testing.T) {
	// Create temporary directories
	tempDir, err := os.MkdirTemp("", "backup_test_")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)
	
	sourceDir := filepath.Join(tempDir, "source")
	backupDir := filepath.Join(tempDir, "backup")
	
	os.MkdirAll(sourceDir, 0755)
	os.MkdirAll(backupDir, 0755)
	
	// Create test files - 5000 files to stress test memory usage
	numFiles := 5000
	t.Logf("Creating %d test files...", numFiles)
	createTestFiles(t, sourceDir, numFiles)
	
	// Test configurations
	tests := []struct {
		name        string
		config      BatchConfig
		expectMemMB float64
	}{
		{
			name: "Small batch, low memory limit",
			config: BatchConfig{
				BatchSize:     100,
				MemoryLimit:   10 * 1024 * 1024, // 10MB
				FlushInterval: 5 * time.Second,
			},
			expectMemMB: 15.0, // Should stay under 15MB
		},
		{
			name: "Medium batch, moderate memory limit",
			config: BatchConfig{
				BatchSize:     500,
				MemoryLimit:   25 * 1024 * 1024, // 25MB
				FlushInterval: 10 * time.Second,
			},
			expectMemMB: 30.0, // Should stay under 30MB
		},
		{
			name: "Large batch, high memory limit",
			config: BatchConfig{
				BatchSize:     1000,
				MemoryLimit:   50 * 1024 * 1024, // 50MB
				FlushInterval: 15 * time.Second,
			},
			expectMemMB: 55.0, // Should stay under 55MB
		},
	}
	
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Clean backup dir for each test
			os.RemoveAll(backupDir)
			os.MkdirAll(backupDir, 0755)
			
			// Record initial memory
			runtime.GC()
			initialMem := getMemoryUsage()
			t.Logf("Initial memory usage: %.2f MB", initialMem)
			
			// Track progress
			var maxMemory float64
			progressCallback := func(progress BackupProgress) {
				currentMem := getMemoryUsage()
				if currentMem > maxMemory {
					maxMemory = currentMem
				}
				
				// Log progress every 1000 files
				if progress.FilesProcessed%1000 == 0 && progress.FilesProcessed > 0 {
					t.Logf("Processed %d files, current memory: %.2f MB", 
						progress.FilesProcessed, currentMem)
				}
			}
			
			// Run backup with custom config
			start := time.Now()
			err := RunBackupWithBatchConfig(
				context.Background(),
				backupDir,
				[]string{sourceDir},
				[]string{}, // No ignore patterns
				progressCallback,
				test.config,
			)
			duration := time.Since(start)
			
			// Check results
			if err != nil {
				t.Fatalf("Backup failed: %v", err)
			}
			
			// Final memory check
			runtime.GC()
			finalMem := getMemoryUsage()
			
			// Log results
			t.Logf("Test '%s' results:", test.name)
			t.Logf("  Duration: %v", duration)
			t.Logf("  Initial memory: %.2f MB", initialMem)
			t.Logf("  Max memory: %.2f MB", maxMemory)
			t.Logf("  Final memory: %.2f MB", finalMem)
			t.Logf("  Memory increase: %.2f MB", maxMemory-initialMem)
			
			// Verify memory usage is within expected bounds
			if maxMemory-initialMem > test.expectMemMB {
				t.Errorf("Memory usage exceeded expected limit: %.2f MB > %.2f MB", 
					maxMemory-initialMem, test.expectMemMB)
			}
			
			// Verify snapshot can be loaded
			snapshot, err := LoadLatestSnapshot(backupDir)
			if err != nil {
				t.Fatalf("Failed to load latest snapshot: %v", err)
			}
			
			expectedFiles := numFiles
			actualFiles := len(snapshot.Files)
			if actualFiles < expectedFiles*90/100 { // Allow 10% tolerance
				t.Errorf("Expected at least %d files in snapshot, got %d", expectedFiles, actualFiles)
			}
			
			t.Logf("  Snapshot contains %d files", actualFiles)
		})
	}
}

// TestStreamingSnapshotWriter tests the streaming snapshot writer directly
func TestStreamingSnapshotWriter(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "snapshot_writer_test_")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)
	
	casDir := filepath.Join(tempDir, "cas")
	os.MkdirAll(casDir, 0755)
	
	// Create streaming snapshot writer with timestamp ID to match LoadLatestSnapshot expectations
	// LoadLatestSnapshot expects a timestamp format like "20250101120000"
	snapshotID := time.Now().Format("20060102150405")
	writer, err := NewStreamingSnapshotWriter(casDir, snapshotID, []string{"/test/source"})
	if err != nil {
		t.Fatalf("Failed to create streaming snapshot writer: %v", err)
	}
	
	// Add test files
	numFiles := 1000
	for i := 0; i < numFiles; i++ {
		entry := &FileEntry{
			Path:    fmt.Sprintf("file%d.txt", i),
			Hash:    fmt.Sprintf("hash%d", i),
			Size:    int64(100 + i),
			ModTime: time.Now(),
		}
		
		err := writer.AddFile(entry)
		if err != nil {
			t.Fatalf("Failed to add file entry %d: %v", i, err)
		}
		
		// Check memory usage periodically
		if i%100 == 0 {
			memUsage := getMemoryUsage()
			t.Logf("Added %d files, memory usage: %.2f MB", i+1, memUsage)
		}
	}
	
	// Close writer
	err = writer.Close()
	if err != nil {
		t.Fatalf("Failed to close streaming snapshot writer: %v", err)
	}
	
	// Verify snapshot was created and can be loaded
	snapshot, err := LoadLatestSnapshot(casDir)
	if err != nil {
		t.Fatalf("Failed to load created snapshot: %v", err)
	}
	
	if len(snapshot.Files) != numFiles {
		t.Errorf("Expected %d files in snapshot, got %d", numFiles, len(snapshot.Files))
	}
	
	if snapshot.ID != snapshotID {
		t.Errorf("Expected snapshot ID '%s', got '%s'", snapshotID, snapshot.ID)
	}
	
	t.Logf("Successfully created and loaded snapshot with %d files", len(snapshot.Files))
}

// TestMemoryStats tests the memory statistics functionality
func TestMemoryStats(t *testing.T) {
	stats := GetMemoryStats()
	
	if stats.Alloc == 0 {
		t.Error("Alloc should be greater than 0")
	}
	
	if stats.Sys == 0 {
		t.Error("Sys should be greater than 0")
	}
	
	t.Logf("Memory Stats:")
	t.Logf("  Alloc: %d bytes (%.2f MB)", stats.Alloc, float64(stats.Alloc)/1024/1024)
	t.Logf("  TotalAlloc: %d bytes (%.2f MB)", stats.TotalAlloc, float64(stats.TotalAlloc)/1024/1024)
	t.Logf("  Sys: %d bytes (%.2f MB)", stats.Sys, float64(stats.Sys)/1024/1024)
	t.Logf("  NumGC: %d", stats.NumGC)
}

// BenchmarkOriginalBackup benchmarks the original backup approach (if available)
// This would require keeping the old implementation for comparison
func BenchmarkMemoryEfficientBackup(b *testing.B) {
	tempDir, err := os.MkdirTemp("", "backup_bench_")
	if err != nil {
		b.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)
	
	sourceDir := filepath.Join(tempDir, "source")
	backupDir := filepath.Join(tempDir, "backup")
	
	os.MkdirAll(sourceDir, 0755)
	os.MkdirAll(backupDir, 0755)
	
	// Create test files
	numFiles := 1000
	for i := 0; i < numFiles; i++ {
		filePath := filepath.Join(sourceDir, fmt.Sprintf("file%d.txt", i))
		content := fmt.Sprintf("Benchmark test file %d content", i)
		os.WriteFile(filePath, []byte(content), 0644)
	}
	
	config := DefaultBatchConfig()
	
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		// Clean backup dir for each iteration
		os.RemoveAll(backupDir)
		os.MkdirAll(backupDir, 0755)
		
		err := RunBackupWithBatchConfig(
			context.Background(),
			backupDir,
			[]string{sourceDir},
			[]string{},
			nil,
			config,
		)
		
		if err != nil {
			b.Fatalf("Backup failed: %v", err)
		}
	}
}