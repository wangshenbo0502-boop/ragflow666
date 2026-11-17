package service

import (
	"encoding/binary"
	"errors"
)

// validateChatWAV accepts uncompressed PCM/IEEE float, including extensible
// WAVE. Chunk sizes are checked before slicing.
func validateChatWAV(data []byte) (int64, error) {
	invalid := errors.New("invalid_audio: WAV data is incomplete or unsupported")
	if len(data) < 44 || len(data) > chatMediaMaxBytes ||
		string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" ||
		uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) {
		return 0, invalid
	}
	var format, samples []byte
	for offset := 12; offset < len(data); {
		if len(data)-offset < 8 {
			return 0, invalid
		}
		size := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		end := uint64(offset) + 8 + size
		if end > uint64(len(data)) || end+(size&1) > uint64(len(data)) {
			return 0, invalid
		}
		switch string(data[offset : offset+4]) {
		case "fmt ":
			if format != nil {
				return 0, invalid
			}
			format = data[offset+8 : int(end)]
		case "data":
			if samples != nil || size == 0 {
				return 0, invalid
			}
			samples = data[offset+8 : int(end)]
		}
		offset = int(end + (size & 1))
	}
	if len(format) < 16 || len(samples) == 0 {
		return 0, invalid
	}
	u16, u32 := binary.LittleEndian.Uint16, binary.LittleEndian.Uint32
	code, channels, bits := u16(format), u16(format[2:]), u16(format[14:])
	rate, byteRate, align := u32(format[4:]), u32(format[8:]), u16(format[12:])
	if len(format) != 16 && (len(format) < 18 || int(u16(format[16:]))+18 != len(format)) {
		return 0, invalid
	}
	if code == 0xfffe {
		if len(format) < 40 || u16(format[16:]) < 22 || u16(format[18:]) != bits ||
			string(format[26:40]) != "\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71" {
			return 0, invalid
		}
		code = u16(format[24:])
	}
	if !(code == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32) ||
		code == 3 && (bits == 32 || bits == 64)) ||
		channels < 1 || channels > 8 || rate < 8000 || rate > 192000 ||
		align != channels*(bits/8) || byteRate != rate*uint32(align) ||
		len(samples)%int(align) != 0 {
		return 0, invalid
	}
	duration := int64(len(samples)) * 1000 / int64(byteRate)
	if duration < 1 || duration > 10*60*1000 {
		return 0, invalid
	}
	return duration, nil
}
