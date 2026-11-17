package service

import (
	"encoding/binary"
	"testing"
)

func chatWAV() []byte {
	const samples = 1600
	data := make([]byte, 44+samples)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 8000)
	binary.LittleEndian.PutUint32(data[28:], 16000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], samples)
	return data
}

func TestChatWAVValidation(t *testing.T) {
	if duration, err := validateChatWAV(chatWAV()); err != nil || duration != 100 {
		t.Fatalf("valid PCM: duration=%d err=%v", duration, err)
	}
	for _, test := range []struct {
		name string
		edit func([]byte) []byte
	}{
		{"header-only", func(b []byte) []byte { return b[:44] }},
		{"truncated", func(b []byte) []byte { return b[:len(b)-1] }},
		{"riff-size", func(b []byte) []byte { b[4]++; return b }},
		{"missing-format", func(b []byte) []byte { copy(b[12:], "JUNK"); return b }},
		{"missing-data", func(b []byte) []byte { copy(b[36:], "JUNK"); return b }},
		{"chunk-overflow", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[40:], ^uint32(0)); return b }},
		{"compressed", func(b []byte) []byte { b[20] = 2; return b }},
		{"zero-channels", func(b []byte) []byte { b[22] = 0; return b }},
		{"bad-align", func(b []byte) []byte { b[32] = 1; return b }},
		{"bad-byte-rate", func(b []byte) []byte { b[28]++; return b }},
		{"bad-sample-rate", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[24:], 1); return b }},
		{"unsupported-bits", func(b []byte) []byte { b[34] = 12; return b }},
		{"duplicate-data", func(b []byte) []byte {
			b = append(b, b[36:]...)
			binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
			return b
		}},
		{"duplicate-format", func(b []byte) []byte {
			b = append(b, b[12:36]...)
			binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
			return b
		}},
		{"unframed-data", func(b []byte) []byte {
			b = append(b, 0, 0)
			binary.LittleEndian.PutUint32(b[40:], 1601)
			binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
			return b
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := validateChatWAV(test.edit(chatWAV())); err == nil {
				t.Fatal("accepted malformed WAV")
			}
		})
	}
}
