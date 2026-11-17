package storage

import (
	"context"
	"errors"
	"io"
)

var ErrObjectTooLarge = errors.New("storage object exceeds byte limit")

type boundedGetter interface {
	GetBounded(context.Context, string, string, int64) ([]byte, error)
}

// GetBounded never falls back to an unbounded object download.
func GetBounded(ctx context.Context, store Storage, bucket, key string, limit int64) ([]byte, error) {
	if limit <= 0 {
		return nil, ErrObjectTooLarge
	}
	reader, ok := store.(boundedGetter)
	if !ok {
		return nil, errors.New("storage does not support bounded downloads")
	}
	return reader.GetBounded(ctx, bucket, key, limit)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		return nil, ErrObjectTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if int64(len(data)) > limit {
		return nil, ErrObjectTooLarge
	}
	return data, err
}
