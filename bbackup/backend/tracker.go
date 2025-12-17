package backend

import (
	"database/sql"
	"fmt"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

// FileTracker interface defines methods to track processed files
type FileTracker interface {
	IsProcessed(path string) bool
	MarkProcessed(path string) error
	Close() error
	GetProcessedCount() (int, error)
}

// MapFileTracker implements FileTracker using an in-memory map
type MapFileTracker struct {
	mu        sync.RWMutex
	processed map[string]bool
}

func NewMapFileTracker(initial map[string]bool) *MapFileTracker {
	if initial == nil {
		initial = make(map[string]bool)
	}
	return &MapFileTracker{
		processed: initial,
	}
}

func (m *MapFileTracker) IsProcessed(path string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.processed[path]
}

func (m *MapFileTracker) MarkProcessed(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.processed[path] = true
	return nil
}

func (m *MapFileTracker) Close() error {
	return nil
}

func (m *MapFileTracker) GetProcessedCount() (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.processed), nil
}

// SQLiteFileTracker implements FileTracker using SQLite
type SQLiteFileTracker struct {
	db *sql.DB
	mu sync.RWMutex // SQLite is thread-safe, but we might want to coordinate close
}

// NewSQLiteFileTracker creates or opens a SQLite database for tracking files
func NewSQLiteFileTracker(dbPath string) (*SQLiteFileTracker, error) {
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	// Create table if not exists
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS processed_files (
			path TEXT PRIMARY KEY,
			processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_path ON processed_files(path);
	`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to create tables: %w", err)
	}

	// Optimization: WAL mode for better concurrency
	_, err = db.Exec("PRAGMA journal_mode=WAL;")
	if err != nil {
		// Just log error but continue, not critical
		fmt.Printf("Warning: Failed to set WAL mode: %v\n", err)
	}
	
	// Synchronous NORMAL is usually safe enough and faster
	_, err = db.Exec("PRAGMA synchronous=NORMAL;")
	if err != nil {
		fmt.Printf("Warning: Failed to set synchronous mode: %v\n", err)
	}

	return &SQLiteFileTracker{
		db: db,
	}, nil
}

func (s *SQLiteFileTracker) IsProcessed(path string) bool {
	var exists int
	err := s.db.QueryRow("SELECT 1 FROM processed_files WHERE path = ?", path).Scan(&exists)
	return err == nil && exists == 1
}

func (s *SQLiteFileTracker) MarkProcessed(path string) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO processed_files (path) VALUES (?)", path)
	return err
}

func (s *SQLiteFileTracker) Close() error {
	return s.db.Close()
}

func (s *SQLiteFileTracker) GetProcessedCount() (int, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM processed_files").Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// GetProcessedFilesMap returns a map of all processed files (use with caution on large DBs)
func (s *SQLiteFileTracker) GetProcessedFilesMap() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT path FROM processed_files")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]bool)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		result[path] = true
	}
	return result, nil
}

// MetaStore manages the overall backup state in SQLite (or separate file)
// For now we keep it simple and just use the tracker for files.
