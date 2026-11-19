package services

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParseDatetime(t *testing.T) {
	// EXIF 三种固定格式:前 19 字符、按本地时区解释(naive astimezone 语义)。
	local := time.Date(2025, 3, 12, 6, 24, 0, 0, time.Local)
	cases := []struct {
		raw  string
		want *time.Time
	}{
		{"2025:03:12 06:24:00", &local},
		{"2025-03-12 06:24:00", &local},
		{"2025-03-12T06:24:00", &local},
		{"2025:03:12 06:24:00.123456", &local}, // 只看前 19 字符
		{"", nil},
		{"not-a-date", nil},
	}
	for _, tc := range cases {
		got := parseDatetime(&tc.raw)
		if tc.want == nil {
			if got != nil {
				t.Errorf("parseDatetime(%q) = %v, want nil", tc.raw, got)
			}
			continue
		}
		if got == nil || !got.Equal(*tc.want) {
			t.Errorf("parseDatetime(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}

	// ISO8601 带时区:保留偏移。
	utc := "2025-03-12T06:24:00+00:00"
	got := parseDatetime(&utc)
	if got == nil || got.UTC().Hour() != 6 {
		t.Fatalf("ISO +00:00 解析 = %v", got)
	}
	zulu := "2025-03-12T06:24:00Z"
	got = parseDatetime(&zulu)
	if got == nil || got.UTC().Hour() != 6 {
		t.Fatalf("Z 后缀解析 = %v", got)
	}
}

func TestDecodeText(t *testing.T) {
	nonil := func(s string) *string { return &s }

	cases := []struct {
		raw  any
		want *string
	}{
		{nil, nil},
		{"", nil},
		{"  \t ", nil},
		{"hello", nonil("hello")},
		{"hello\x00", nonil("hello")},
		{" hello \x00", nonil("hello")},
		// latin-1 字节序列能按 utf-8 解码时做乱码修复。
		{[]byte{0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd}, nonil("你好")},
		// 无效 utf-8 → latin-1 直解 → 再修复无效则原样。
		{[]byte{0xe4, 0x00}, nonil("ä")},
	}
	for _, tc := range cases {
		got := decodeText(tc.raw)
		if tc.want == nil {
			if got != nil {
				t.Errorf("decodeText(%v) = %q, want nil", tc.raw, *got)
			}
			continue
		}
		if got == nil || *got != *tc.want {
			t.Errorf("decodeText(%v) = %v, want %q", tc.raw, got, *tc.want)
		}
	}
}

func TestDecodeXPText(t *testing.T) {
	// "标题" 的 UTF-16LE 编码。
	encoded := []byte{0x07, 0x68, 0x98, 0x98, 0x00, 0x00}
	got := decodeXPText(encoded)
	if got == nil || *got != "标题" {
		t.Fatalf("decodeXPText = %v, want 标题", got)
	}

	if got := decodeXPText(nil); got != nil {
		t.Fatalf("nil 应返回 nil, got %q", *got)
	}
}

func TestGPSText(t *testing.T) {
	lat := 25.691111
	lon := 100.271944
	got := gpsLocationText(&lat, &lon, []byte("N"), []byte("E"))
	if got == nil || *got != "25.691111, 100.271944" {
		t.Fatalf("gps text = %v, want 25.691111, 100.271944", got)
	}

	south := gpsLocationText(&lat, &lon, []byte("S"), []byte("w"))
	if south == nil || *south != "-25.691111, -100.271944" {
		t.Fatalf("S/W 半球 = %v", south)
	}

	if gpsLocationText(&lat, nil, []byte("N"), []byte("E")) != nil {
		t.Fatal("缺经度应返回 nil")
	}
}

// buildExifJPEG 在 ffmpeg 生成的 JPEG 上注入手工 EXIF:
// IFD0 {ImageDescription, XPTitle(UTF-16LE), DateTime, ExifIFD 指针, GPS 指针},
// ExifIFD {DateTimeOriginal}, GPS {latRef N, lat(25,41,81/10), lonRef E, lon(100,16,19)}。
// 布局:头(8) + IFD0 表 + ExifIFD 表 + GPSIFD 表 + 数据池。
func buildExifJPEG(t *testing.T, path string) {
	t.Helper()
	genTestImage(t, path)
	base, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	u16 := func(v uint16) []byte { b := make([]byte, 2); binary.LittleEndian.PutUint16(b, v); return b }
	u32 := func(v uint32) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, v); return b }
	entryOffset := func(tag, typ uint16, count uint32, offset uint32) []byte {
		out := append(u16(tag), u16(typ)...)
		out = append(out, u32(count)...)
		return append(out, u32(offset)...)
	}
	entryInline := func(tag, typ uint16, count uint32, value []byte) []byte {
		out := append(u16(tag), u16(typ)...)
		out = append(out, u32(count)...)
		for len(value) < 4 {
			value = append(value, 0)
		}
		return append(out, value...)
	}

	// 数据池:blob 追加并记录池内偏移;绝对偏移在确定表尺寸后回填。
	var pool []byte
	poolIndex := func() uint32 { return uint32(len(pool)) }
	blob := func(b []byte) uint32 {
		off := poolIndex()
		pool = append(pool, b...)
		return off
	}

	descText := []byte("清晨的第一缕光\x00")
	xpTitle := []byte{0x07, 0x68, 0x98, 0x98, 0x00, 0x00} // "标题" UTF-16LE
	dateText := []byte("2025:03:12 08:00:00\x00")
	origText := []byte("2025:03:12 06:24:00\x00")

	latRational := []byte{}
	for _, pair := range [][2]uint32{{25, 1}, {41, 1}, {28, 1}} {
		latRational = append(latRational, u32(pair[0])...)
		latRational = append(latRational, u32(pair[1])...)
	}
	lonRational := []byte{}
	for _, pair := range [][2]uint32{{100, 1}, {16, 1}, {1900, 100}} {
		lonRational = append(lonRational, u32(pair[0])...)
		lonRational = append(lonRational, u32(pair[1])...)
	}

	descOff := blob(descText)
	xpOff := blob(xpTitle)
	dateOff := blob(dateText)
	origOff := blob(origText)
	latOff := blob(latRational)
	lonOff := blob(lonRational)

	ifd0Size := 2 + 5*12 + 4
	exifIFDSize := 2 + 1*12 + 4
	gpsIFDSize := 2 + 4*12 + 4
	poolStart := uint32(8 + ifd0Size + exifIFDSize + gpsIFDSize)
	abs := func(poolOff uint32) uint32 { return poolStart + poolOff }

	ifd0Offset := uint32(8)
	exifIFDOffset := ifd0Offset + uint32(ifd0Size)
	gpsIFDOffset := exifIFDOffset + uint32(exifIFDSize)

	ifd0Table := []byte{0x05, 0x00}
	ifd0Table = append(ifd0Table,
		entryOffset(0x010E, 2, uint32(len(descText)), abs(descOff))...,
	)
	ifd0Table = append(ifd0Table,
		entryOffset(0x9C9C, 1, uint32(len(xpTitle)), abs(xpOff))...,
	)
	ifd0Table = append(ifd0Table,
		entryOffset(0x0132, 2, uint32(len(dateText)), abs(dateOff))...,
	)
	ifd0Table = append(ifd0Table, entryOffset(0x8769, 4, 1, exifIFDOffset)...)
	ifd0Table = append(ifd0Table, entryOffset(0x8825, 4, 1, gpsIFDOffset)...)
	ifd0Table = append(ifd0Table, u32(0)...)

	exifIFDTable := append([]byte{0x01, 0x00},
		entryOffset(0x9003, 2, uint32(len(origText)), abs(origOff))...)
	exifIFDTable = append(exifIFDTable, u32(0)...)

	gpsIFDTable := []byte{0x04, 0x00}
	gpsIFDTable = append(gpsIFDTable, entryInline(0x0001, 2, 2, []byte{'N', 0x00})...)
	gpsIFDTable = append(gpsIFDTable, entryOffset(0x0002, 5, 3, abs(latOff))...)
	gpsIFDTable = append(gpsIFDTable, entryInline(0x0003, 2, 2, []byte{'E', 0x00})...)
	gpsIFDTable = append(gpsIFDTable, entryOffset(0x0004, 5, 3, abs(lonOff))...)
	gpsIFDTable = append(gpsIFDTable, u32(0)...)

	tiff := []byte{}
	tiff = append(tiff, []byte("II")...)
	tiff = append(tiff, u16(42)...)
	tiff = append(tiff, u32(ifd0Offset)...)
	tiff = append(tiff, ifd0Table...)
	tiff = append(tiff, exifIFDTable...)
	tiff = append(tiff, gpsIFDTable...)
	tiff = append(tiff, pool...)

	app1Payload := append([]byte("Exif\x00\x00"), tiff...)
	// JPEG 段长度为大端(含长度字段自身 2 字节);u16 仅用于 TIFF 内容(II 小端)。
	segLen := len(app1Payload) + 2
	app1 := append([]byte{0xFF, 0xE1}, byte(segLen>>8), byte(segLen))
	app1 = append(app1, app1Payload...)

	out := append([]byte{0xFF, 0xD8}, app1...)
	out = append(out, base[2:]...)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadImageMetadataWithExif(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "photo.jpg")
	buildExifJPEG(t, path)

	meta := ReadImageMetadata(path)
	if meta.Width == nil || meta.Height == nil {
		t.Fatal("应读到宽高")
	}
	if *meta.Width != 4000 || *meta.Height != 3000 {
		t.Fatalf("宽高 = (%d, %d), want (4000, 3000)", *meta.Width, *meta.Height)
	}
	if meta.Title == nil || *meta.Title != "标题" {
		t.Fatalf("XPTitle = %v, want 标题", meta.Title)
	}
	if meta.Description == nil || *meta.Description != "清晨的第一缕光" {
		t.Fatalf("Description = %v", meta.Description)
	}
	if meta.CapturedAt == nil {
		t.Fatal("应读到 DateTimeOriginal")
	}
	// EXIF 无时区 → 本地时区解释。
	want := time.Date(2025, 3, 12, 6, 24, 0, 0, time.Local)
	if !meta.CapturedAt.Equal(want) {
		t.Fatalf("CapturedAt = %v, want %v", meta.CapturedAt, want)
	}
	if meta.Location == nil {
		t.Fatal("应读到 GPS 位置")
	}
	if *meta.Location != "25.691111, 100.271944" {
		t.Fatalf("Location = %q, want 25.691111, 100.271944", *meta.Location)
	}
	if meta.DurationSeconds != nil {
		t.Fatal("照片不应有 duration")
	}
}

func TestReadImageMetadataWithoutExif(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "plain.jpg")
	genTestImage(t, path)

	meta := ReadImageMetadata(path)
	if meta.Width == nil || meta.Height == nil {
		t.Fatal("应读到宽高")
	}
	if meta.Title != nil || meta.Description != nil || meta.Location != nil || meta.CapturedAt != nil {
		t.Fatalf("无 EXIF 应全空: %+v", meta)
	}
}

func TestReadImageMetadataGarbage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "broken.jpg")
	if err := os.WriteFile(path, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := ReadImageMetadata(path)
	if meta.Width != nil || meta.Height != nil || meta.Title != nil {
		t.Fatalf("损坏文件应返回空元数据: %+v", meta)
	}
}

func genTestVideo(t *testing.T, path string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
		"-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("生成测试视频失败: %v\n%s", err, out)
	}
}

func TestReadVideoMetadata(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clip.mp4")
	genTestVideo(t, path)

	meta := ReadVideoMetadata(path)
	if meta.Width == nil || *meta.Width != 320 || meta.Height == nil || *meta.Height != 240 {
		t.Fatalf("视频宽高 = (%v, %v), want (320, 240)", meta.Width, meta.Height)
	}
	if meta.DurationSeconds == nil || *meta.DurationSeconds != 2 {
		t.Fatalf("duration = %v, want 2", meta.DurationSeconds)
	}
	if meta.CapturedAt == nil {
		t.Fatal("应回退到文件 mtime")
	}
	if info, err := os.Stat(path); err == nil {
		if !meta.CapturedAt.Equal(info.ModTime().UTC()) {
			t.Fatalf("captured_at 应为 mtime: %v vs %v", meta.CapturedAt, info.ModTime().UTC())
		}
	}
}

func TestExtractMemoryMetadataDispatch(t *testing.T) {
	dir := t.TempDir()
	jpg := filepath.Join(dir, "p.jpg")
	genTestImage(t, jpg)
	meta := ExtractMemoryMetadata(jpg, "photo")
	if meta.Width == nil {
		t.Fatal("photo 分发应读图")
	}

	mp4 := filepath.Join(dir, "v.mp4")
	genTestVideo(t, mp4)
	meta = ExtractMemoryMetadata(mp4, "video")
	if meta.DurationSeconds == nil {
		t.Fatal("video 分发应读 ffprobe")
	}
}
