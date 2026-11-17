package storage

import (
	"bytes"
	"errors"
	"testing"
)

func TestReadBoundedDoesNotDrainOversizedObject(t *testing.T) {
	reader := bytes.NewReader(make([]byte, 100))
	data, err := readBounded(reader, 10)
	if !errors.Is(err, ErrObjectTooLarge) || data != nil || reader.Len() != 89 {
		t.Fatalf("oversized read: data=%v err=%v remaining=%d", data, err, reader.Len())
	}
	exact := []byte("exact")
	data, err = readBounded(bytes.NewReader(exact), int64(len(exact)))
	if err != nil || !bytes.Equal(data, exact) {
		t.Fatalf("exact limit read: data=%q err=%v", data, err)
	}
}

func TestMemoryBoundedDownload(t *testing.T) {
	store := NewMemoryStorage()
	if err := store.Put(t.Context(), "files", "large", []byte("12345")); err != nil {
		t.Fatal(err)
	}
	if data, err := GetBounded(t.Context(), store, "files", "large", 4); data != nil || !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("oversized download: %q %v", data, err)
	}
	data, err := GetBounded(t.Context(), store, "files", "large", 5)
	if err != nil || string(data) != "12345" {
		t.Fatalf("exact download: %q %v", data, err)
	}
	data[0] = 'x'
	original, _ := store.Get(t.Context(), "files", "large")
	if string(original) != "12345" {
		t.Fatal("bounded download exposed mutable storage bytes")
	}
}
