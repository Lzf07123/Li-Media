// memory_metadata.go 对齐原 app/services/memory_metadata.py:
// 照片 EXIF 与视频 ffprobe 元数据提取,派生 title/description/location/
// captured_at/duration/width/height。
//
// 实现路线差异(有意为之):Python 用 Pillow 读取 EXIF;Go 标准库无 EXIF
// 读取器,这里内置一个只覆盖所需 tag 的精简 TIFF/EXIF 解析器(IFD0 的
// ImageDescription/XPTitle/DateTime、ExifIFD 的 DateTimeOriginal/
// DateTimeDigitized/XPComment、GPS IFD 的经纬度)。
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"limedia/backend/internal/models"
)

// MemoryMetadata 单个源文件提取出的元数据(对齐 dataclass MemoryMetadata)。
type MemoryMetadata struct {
	Title           *string
	Description     *string
	Location        *string
	CapturedAt      *time.Time
	DurationSeconds *int
	Width           *int
	Height          *int
}

// ---- 文本解码(对齐 _decode_text / _decode_xp_text) ----

// decodeText 提取可读文本:bytes 先按 utf-8 严格解码、失败退 latin-1;
// 随后 strip → 去 NUL → strip,再做一次 latin-1→utf-8 乱码修复;
// 全空白返回 nil。
func decodeText(value any) *string {
	if value == nil {
		return nil
	}
	var s string
	switch v := value.(type) {
	case []byte:
		if utf8.Valid(v) {
			s = string(v)
		} else {
			s = latin1Decode(v)
		}
	case string:
		s = v
	default:
		s = fmt.Sprintf("%v", v)
	}

	text := strings.TrimSpace(s)
	text = strings.TrimRight(text, "\x00")
	text = strings.TrimSpace(text)
	text = fixLatin1Mojibake(text)
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return &text
}

// latin1Decode latin-1 字节直接映射为同码点字符串。
func latin1Decode(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for _, v := range b {
		sb.WriteRune(rune(v))
	}
	return sb.String()
}

// fixLatin1Mojibake 对齐 `text.encode("latin-1").decode("utf-8")`:
// 全部字符都在 latin-1 范围(≤ U+00FF)时按原始字节尝试重新以 utf-8
// 解码;任一字符越界或字节序列无效则原样返回。
func fixLatin1Mojibake(text string) string {
	hasHigh := false
	for _, r := range text {
		if r > 0xFF {
			return text
		}
		if r > 0x7F {
			hasHigh = true
		}
	}
	if !hasHigh {
		return text
	}
	raw := make([]byte, 0, len(text))
	for _, r := range text {
		raw = append(raw, byte(r))
	}
	if !utf8.Valid(raw) {
		return text
	}
	return string(raw)
}

// decodeXPText XP 系列 tag 为 UTF-16LE 编码(对齐 _decode_xp_text)。
func decodeXPText(value any) *string {
	if b, ok := value.([]byte); ok {
		return decodeText(utf16LEDecode(b))
	}
	return decodeText(value)
}

// utf16LEDecode 以 UTF-16LE 解码;无效代理对按 errors="ignore" 跳过。
func utf16LEDecode(b []byte) string {
	units := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		units = append(units, uint16(b[i])|uint16(b[i+1])<<8)
	}
	var sb strings.Builder
	for i := 0; i < len(units); i++ {
		u := units[i]
		switch {
		case u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) &&
			units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF:
			r := ((rune(u)-0xD800)<<10 | (rune(units[i+1]) - 0xDC00)) + 0x10000
			sb.WriteRune(r)
			i++
		case u >= 0xD800 && u <= 0xDFFF:
			// 无效代理对:忽略
		default:
			sb.WriteRune(rune(u))
		}
	}
	return sb.String()
}

// ---- 时间解析(对齐 _parse_datetime) ----

// parseDatetime EXIF/ffprobe 时间字符串解析。前三种格式只看前 19 个
// 字符并按本地时区解释(对齐 naive astimezone());其余走 ISO8601
// 回退,带时区保留,naive 同样按本地时区解释。
func parseDatetime(value *string) *time.Time {
	if value == nil || *value == "" {
		return nil
	}
	s := *value

	// value[:19] 的三种固定格式(naive → astimezone() 语义)。
	prefix := s
	if len(prefix) > 19 {
		prefix = prefix[:19]
	}
	for _, layout := range [...]string{
		"2006:01:02 15:04:05", // %Y:%m:%d %H:%M:%S
		"2006-01-02 15:04:05", // %Y-%m-%d %H:%M:%S
		"2006-01-02T15:04:05", // %Y-%m-%dT%H:%M:%S
	} {
		if t, err := time.ParseInLocation(layout, prefix, time.Local); err == nil {
			return &t
		}
	}

	// fromisoformat 回退:Z → +00:00 后尝试带/不带时区的 ISO 变体。
	iso := strings.ReplaceAll(s, "Z", "+00:00")
	for _, layout := range [...]string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999-07:00",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05-07:00",
	} {
		if t, err := time.Parse(layout, iso); err == nil {
			return &t
		}
	}
	for _, layout := range [...]string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if t, err := time.ParseInLocation(layout, iso, time.Local); err == nil {
			return &t
		}
	}
	return nil
}

// ---- GPS(对齐 _degrees / _gps_location) ----

type gpsRational struct {
	num uint32
	den uint32
}

// gpsDegrees 三元组 (deg, min, sec) → 度;分母为 0 视为无效
// (Python 侧 ZeroDivisionError 会让整条元数据落空,此处只丢位置)。
func gpsDegrees(rs [3]gpsRational) *float64 {
	for _, r := range rs {
		if r.den == 0 {
			return nil
		}
	}
	deg := float64(rs[0].num)/float64(rs[0].den) +
		float64(rs[1].num)/float64(rs[1].den)/60 +
		float64(rs[2].num)/float64(rs[2].den)/3600
	return &deg
}

// gpsLocationText 格式化 "lat, lon"(保留 6 位小数,南/西为负)。
func gpsLocationText(lat, lon *float64, latRef, lonRef []byte) *string {
	if lat == nil || lon == nil {
		return nil
	}
	latitude := *lat
	longitude := *lon
	if ref := decodeText(latRef); ref != nil && (*ref == "S" || *ref == "s") {
		latitude = -latitude
	}
	if ref := decodeText(lonRef); ref != nil && (*ref == "W" || *ref == "w") {
		longitude = -longitude
	}
	text := fmt.Sprintf("%.6f, %.6f", latitude, longitude)
	return &text
}

// ---- 精简 EXIF 解析 ----

type exifFields struct {
	description       []byte  // IFD0 0x010E ImageDescription
	xpTitle           []byte  // IFD0 0x9C9C XPTitle(UTF-16LE)
	dateTime          []byte  // IFD0 0x0132 DateTime
	xpComment         []byte  // ExifIFD 0x9C9E XPComment(UTF-16LE)
	dateTimeOriginal  []byte  // ExifIFD 0x9003
	dateTimeDigitized []byte  // ExifIFD 0x9004
	gpsLatRef         []byte  // GPS 0x0001
	gpsLat            [3]gpsRational
	gpsHasLat         bool
	gpsLonRef         []byte // GPS 0x0003
	gpsLon            [3]gpsRational
	gpsHasLon         bool
}

// exifTIFF 从 JPEG APP1 段(或裸 TIFF 头)提取 EXIF TIFF 数据块。
func exifTIFF(content []byte) []byte {
	if len(content) >= 8 && (string(content[:4]) == "II\x2a\x00" || string(content[:4]) == "MM\x00\x2a") {
		return content
	}
	if len(content) < 4 || content[0] != 0xFF || content[1] != 0xD8 {
		return nil
	}
	pos := 2
	for pos+4 <= len(content) {
		if content[pos] != 0xFF {
			return nil
		}
		marker := content[pos+1]
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) { // SOI/RST
			pos += 2
			continue
		}
		if pos+4 > len(content) {
			return nil
		}
		length := int(content[pos+2])<<8 | int(content[pos+3])
		if marker == 0xE1 && length >= 10 { // APP1
			segment := content[pos+4 : minInt(pos+2+length, len(content))]
			if len(segment) > 6 && string(segment[:6]) == "Exif\x00\x00" {
				return segment[6:]
			}
		}
		pos += 2 + length
	}
	return nil
}

type tiffOrder struct {
	little bool
}

func (o tiffOrder) u16(b []byte, off int) uint16 {
	if off < 0 || off+2 > len(b) {
		return 0
	}
	if o.little {
		return uint16(b[off]) | uint16(b[off+1])<<8
	}
	return uint16(b[off])<<8 | uint16(b[off+1])
}

func (o tiffOrder) u32(b []byte, off int) uint32 {
	if off < 0 || off+4 > len(b) {
		return 0
	}
	if o.little {
		return uint32(b[off]) | uint32(b[off+1])<<8 | uint32(b[off+2])<<16 | uint32(b[off+3])<<24
	}
	return uint32(b[off])<<24 | uint32(b[off+1])<<16 | uint32(b[off+2])<<8 | uint32(b[off+3])
}

// exifEntryValue 按 IFD entry 的 type/count 取出值字节(内联或偏移)。
func exifEntryValue(tiff []byte, o tiffOrder, entry int) []byte {
	if entry < 0 || entry+12 > len(tiff) {
		return nil
	}
	tagType := o.u16(tiff, entry+2)
	count := int(o.u32(tiff, entry+4))
	var unit int
	switch tagType {
	case 1, 2, 7: // BYTE / ASCII / UNDEFINED
		unit = 1
	case 3: // SHORT
		unit = 2
	case 4: // LONG
		unit = 4
	case 5, 10: // RATIONAL / SRATIONAL
		unit = 8
	default:
		return nil
	}
	size := unit * count
	if size <= 0 {
		return nil
	}
	if size <= 4 {
		return tiff[entry+8 : entry+8+size]
	}
	offset := int(o.u32(tiff, entry+8))
	if offset < 0 || offset+size > len(tiff) || offset+size < offset {
		return nil
	}
	return tiff[offset : offset+size]
}

// exifRationals 读取 RATIONAL 数组。
func exifRationals(raw []byte, o tiffOrder) ([3]gpsRational, bool) {
	var out [3]gpsRational
	if len(raw) < 24 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		out[i] = gpsRational{
			num: o.u32(raw, i*8),
			den: o.u32(raw, i*8+4),
		}
	}
	return out, true
}

// parseExifFields 遍历 IFD0 / ExifIFD / GPS IFD,只取所需 tag。
func parseExifFields(tiff []byte) *exifFields {
	if len(tiff) < 8 {
		return nil
	}
	var o tiffOrder
	switch string(tiff[:2]) {
	case "II":
		o = tiffOrder{little: true}
	case "MM":
		o = tiffOrder{little: false}
	default:
		return nil
	}

	fields := &exifFields{}
	walkIFD := func(ifdOffset int, visit func(tag uint16, raw []byte) bool) {
		if ifdOffset <= 0 || ifdOffset+2 > len(tiff) {
			return
		}
		entryCount := int(o.u16(tiff, ifdOffset))
		for i := 0; i < entryCount; i++ {
			entry := ifdOffset + 2 + i*12
			if entry+12 > len(tiff) {
				return
			}
			tag := o.u16(tiff, entry)
			if !visit(tag, exifEntryValue(tiff, o, entry)) {
				return
			}
		}
	}

	var exifIFDOffset, gpsIFDOffset int
	walkIFD(8, func(tag uint16, raw []byte) bool {
		switch tag {
		case 0x010E: // ImageDescription
			fields.description = raw
		case 0x9C9C: // XPTitle
			fields.xpTitle = raw
		case 0x0132: // DateTime
			fields.dateTime = raw
		case 0x8769: // ExifIFD pointer
			if raw != nil && len(raw) >= 4 {
				exifIFDOffset = int(o.u32(raw, 0))
			}
		case 0x8825: // GPS IFD pointer
			if raw != nil && len(raw) >= 4 {
				gpsIFDOffset = int(o.u32(raw, 0))
			}
		}
		return true
	})

	walkIFD(exifIFDOffset, func(tag uint16, raw []byte) bool {
		switch tag {
		case 0x9003:
			fields.dateTimeOriginal = raw
		case 0x9004:
			fields.dateTimeDigitized = raw
		case 0x9C9E: // XPComment
			fields.xpComment = raw
		}
		return true
	})

	walkIFD(gpsIFDOffset, func(tag uint16, raw []byte) bool {
		switch tag {
		case 0x0001:
			fields.gpsLatRef = raw
		case 0x0002:
			if rs, ok := exifRationals(raw, o); ok {
				fields.gpsLat = rs
				fields.gpsHasLat = true
			}
		case 0x0003:
			fields.gpsLonRef = raw
		case 0x0004:
			if rs, ok := exifRationals(raw, o); ok {
				fields.gpsLon = rs
				fields.gpsHasLon = true
			}
		}
		return true
	})
	return fields
}

// ---- 照片(对齐 read_image_metadata) ----

// ReadImageMetadata 读取照片元数据;无法解码或读取失败返回空结构。
func ReadImageMetadata(path string) *MemoryMetadata {
	empty := &MemoryMetadata{}
	content, err := os.ReadFile(path)
	if err != nil {
		return empty
	}

	// 宽高取转置后尺寸(对齐 ImageOps.exif_transpose(image).size);
	// 无法解码(PIL open 失败的等价场景)整体返回空。
	width, height := ReadImageDimensions(content)
	if width == nil || height == nil {
		return empty
	}

	meta := &MemoryMetadata{Width: width, Height: height}
	fields := parseExifFields(exifTIFF(content))
	if fields == nil {
		return meta
	}

	meta.Title = decodeXPText(fields.xpTitle)
	meta.Description = firstTextPtr(
		decodeText(fields.description),
		decodeXPText(fields.xpComment),
	)
	meta.Location = gpsLocationFromFields(fields)
	meta.CapturedAt = firstTimePtr(
		parseDatetime(decodeText(fields.dateTimeOriginal)),
		parseDatetime(decodeText(fields.dateTimeDigitized)),
		parseDatetime(decodeText(fields.dateTime)),
	)
	return meta
}

func gpsLocationFromFields(fields *exifFields) *string {
	if !fields.gpsHasLat || !fields.gpsHasLon {
		return nil
	}
	lat := gpsDegrees(fields.gpsLat)
	lon := gpsDegrees(fields.gpsLon)
	return gpsLocationText(lat, lon, fields.gpsLatRef, fields.gpsLonRef)
}

func firstTextPtr(values ...*string) *string {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func firstTimePtr(values ...*time.Time) *time.Time {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

// ---- 视频(对齐 read_video_metadata) ----

type ffprobeStream struct {
	CodecType string            `json:"codec_type"`
	Width     any               `json:"width"`
	Height    any               `json:"height"`
	Duration  any               `json:"duration"`
	Tags      map[string]string `json:"tags"`
}

type ffprobeFormat struct {
	Duration any               `json:"duration"`
	Tags     map[string]string `json:"tags"`
}

type ffprobePayload struct {
	Format  ffprobeFormat   `json:"format"`
	Streams []ffprobeStream `json:"streams"`
}

// anyToFloat duration/width 兼容字符串与数字。
func anyToFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func anyToInt(v any) *int {
	f, ok := anyToFloat(v)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	n := int(math.Trunc(f))
	return &n
}

func modTimeUTC(path string) *time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	at := info.ModTime().UTC()
	return &at
}

// ReadVideoMetadata ffprobe 提取视频元数据;探测失败回退文件 mtime。
func ReadVideoMetadata(path string) *MemoryMetadata {
	fallback := func() *MemoryMetadata {
		return &MemoryMetadata{CapturedAt: modTimeUTC(path)}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx,
		"ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path,
	).Output()
	if err != nil {
		return fallback()
	}
	var payload ffprobePayload
	if err := json.Unmarshal(out, &payload); err != nil {
		return fallback()
	}

	var videoStream ffprobeStream
	for _, stream := range payload.Streams {
		if stream.CodecType == "video" {
			videoStream = stream
			break
		}
	}
	formatTags := payload.Format.Tags
	streamTags := videoStream.Tags

	duration := payload.Format.Duration
	if duration == nil {
		duration = videoStream.Duration
	}
	var durationSeconds *int
	if duration != nil {
		if f, ok := anyToFloat(duration); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			n := int(math.Trunc(f))
			durationSeconds = &n
		}
	}

	var capturedAt *time.Time
	if text := decodeText(tagValue(formatTags, "creation_time")); text != nil {
		capturedAt = parseDatetime(text)
	}
	if capturedAt == nil {
		if text := decodeText(tagValue(streamTags, "creation_time")); text != nil {
			capturedAt = parseDatetime(text)
		}
	}
	if capturedAt == nil {
		capturedAt = modTimeUTC(path)
	}

	return &MemoryMetadata{
		Title: firstTextPtr(
			decodeText(tagValue(formatTags, "title")),
			decodeText(tagValue(streamTags, "title")),
		),
		Description: firstTextPtr(
			decodeText(tagValue(formatTags, "description")),
			decodeText(tagValue(formatTags, "comment")),
			decodeText(tagValue(streamTags, "description")),
		),
		Location: firstTextPtr(
			decodeText(tagValue(formatTags, "location")),
			decodeText(tagValue(formatTags, "com.apple.quicktime.location.ISO6709")),
		),
		CapturedAt:      capturedAt,
		DurationSeconds: durationSeconds,
		Width:           anyToInt(videoStream.Width),
		Height:          anyToInt(videoStream.Height),
	}
}

// tagValue 取 tag;ffprobe tags 均为字符串,缺失返回 nil。
func tagValue(tags map[string]string, key string) any {
	if tags == nil {
		return nil
	}
	if v, ok := tags[key]; ok {
		return v
	}
	return nil
}

// ExtractMemoryMetadata 按类型分发(对齐 extract_memory_metadata)。
func ExtractMemoryMetadata(path string, kind models.MemoryKind) *MemoryMetadata {
	if kind == models.MemoryKindPhoto {
		return ReadImageMetadata(path)
	}
	return ReadVideoMetadata(path)
}
