// Package alertchart renders the short-position chart an alert email carries
// inline. The paths come from golang.org/x/image/vector and the labels from IBM Plex
// Mono, which is embedded rather than read from the system, so no font on the host
// is involved.
//
// The canvas is 2x the size it is shown at (960x480 for 480x240 on a phone, and
// 552 wide on a desktop), so the labels stay legible when the email shrinks. There
// are two palettes: Render draws the light card, RenderDark draws the dark room.
// Both are deterministic for a given build and architecture; prod renders on
// linux/amd64.
//
// The font files in fonts/ are IBM Plex Mono from
// https://github.com/google/fonts/tree/main/ofl/ibmplexmono, licensed under the
// SIL Open Font License 1.1 (fonts/OFL.txt).
package alertchart

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"strconv"
	"sync"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"

	_ "embed"
)

//go:embed fonts/IBMPlexMono-Regular.ttf
var regularTTF []byte

//go:embed fonts/IBMPlexMono-SemiBold.ttf
var semiboldTTF []byte

// Canvas and plot geometry, in pixels at 2x.
const (
	Width      = 960
	Height     = 480
	plotLeft   = 124
	plotRight  = 40
	plotTop    = 56
	plotBottom = 76
	plotW      = Width - plotLeft - plotRight
	plotH      = Height - plotTop - plotBottom
	baselineY  = Height - plotBottom
	rightX     = Width - plotRight
)

// MinPoints is the fewest readings a chart draws. Two readings make a line, and
// that is enough for a stock that has only just been reported. A single reading
// has no line, so Render returns ErrTooFewPoints and the email skips the chart.
const MinPoints = 2

// shortHistory is the reading count under which every reading gets a dot and its
// own date label. Fewer readings than this are spread across the plot instead of
// running edge to edge, so a dot is never on the frame.
const shortHistory = 20

// ErrTooFewPoints is returned for a series shorter than MinPoints.
var ErrTooFewPoints = errors.New("alertchart: at least two points are needed")

// palette is one colour scheme. Ring is always the canvas colour, so a marker reads
// as cut out of the background.
type palette struct {
	bg       color.RGBA
	grid     color.RGBA
	axis     color.RGBA // axis labels
	line     color.RGBA
	fill     color.NRGBA // the area under the line
	alert    color.RGBA  // the threshold line and its label
	ink      color.RGBA  // the latest value label
	marker   color.RGBA  // the report-date marker
	compared color.RGBA  // the compared-date marker
}

// lightPalette is the brand palette from DESIGN.md, on the paper card.
var lightPalette = palette{
	bg:       color.RGBA{0xFD, 0xFD, 0xFC, 0xFF},
	grid:     color.RGBA{0xED, 0xE9, 0xE4, 0xFF},
	axis:     color.RGBA{0x72, 0x62, 0x5A, 0xFF},
	line:     color.RGBA{0xD1, 0x6A, 0x47, 0xFF},
	fill:     color.NRGBA{0xD1, 0x6A, 0x47, 36}, // about 14% alpha
	alert:    color.RGBA{0x9E, 0x52, 0x10, 0xFF},
	ink:      color.RGBA{0x48, 0x39, 0x32, 0xFF},
	marker:   color.RGBA{0x9E, 0x52, 0x10, 0xFF},
	compared: color.RGBA{0x72, 0x62, 0x5A, 0xFF},
}

// darkPalette is the dark-room palette, on lifted black.
var darkPalette = palette{
	bg:       color.RGBA{0x12, 0x12, 0x12, 0xFF},
	grid:     color.RGBA{0x2A, 0x24, 0x1F, 0xFF},
	axis:     color.RGBA{0xA3, 0x9A, 0x75, 0xFF},
	line:     color.RGBA{0xE1, 0x7E, 0x51, 0xFF},
	fill:     color.NRGBA{0xE1, 0x7E, 0x51, 23}, // about 9% alpha
	alert:    color.RGBA{0xFF, 0xAC, 0x4D, 0xFF},
	ink:      color.RGBA{0xE8, 0xDE, 0xB5, 0xFF},
	marker:   color.RGBA{0xFF, 0xAC, 0x4D, 0xFF},
	compared: color.RGBA{0xA3, 0x9A, 0x75, 0xFF},
}

// Text sizes, in pixels at 2x.
const (
	axisSize      = 28
	thresholdSize = 24
	valueSize     = 34
)

// Point is one report date's reading. Date is YYYY-MM-DD and Value is the short
// percent of shares on issue.
type Point struct {
	Date  string
	Value float64
}

// Spec is one chart. Threshold is drawn as a dashed alert level when set.
// ReportDate is the latest report and gets the large marker. ComparedTo is the
// report it was compared with and gets the small marker.
type Spec struct {
	Points     []Point
	Threshold  *float64
	ReportDate string
	ComparedTo string
}

// faceSet holds the parsed faces. They are built once; a parse failure is an
// embedding bug and is returned to every caller.
type faceSet struct {
	axis, threshold, value font.Face
}

var loadFaces = sync.OnceValues(func() (faceSet, error) {
	reg, err := opentype.Parse(regularTTF)
	if err != nil {
		return faceSet{}, fmt.Errorf("alertchart: parse regular font: %w", err)
	}
	semi, err := opentype.Parse(semiboldTTF)
	if err != nil {
		return faceSet{}, fmt.Errorf("alertchart: parse semibold font: %w", err)
	}
	mk := func(f *opentype.Font, size float64) (font.Face, error) {
		return opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingNone})
	}
	var fs faceSet
	if fs.axis, err = mk(reg, axisSize); err != nil {
		return faceSet{}, err
	}
	if fs.threshold, err = mk(reg, thresholdSize); err != nil {
		return faceSet{}, err
	}
	if fs.value, err = mk(semi, valueSize); err != nil {
		return faceSet{}, err
	}
	return fs, nil
})

// Render draws the light-card chart as a PNG.
func Render(s Spec) ([]byte, error) { return render(s, lightPalette) }

// RenderDark draws the same chart in the dark-room palette, for a dark email client.
func RenderDark(s Spec) ([]byte, error) { return render(s, darkPalette) }

func render(s Spec, pal palette) ([]byte, error) {
	n := len(s.Points)
	if n < MinPoints {
		return nil, ErrTooFewPoints
	}
	dates := make([]time.Time, n)
	maxVal := 0.0
	for i, p := range s.Points {
		t, err := time.Parse(dateLayout, p.Date)
		if err != nil {
			return nil, fmt.Errorf("alertchart: point %d: bad date %q: %w", i, p.Date, err)
		}
		dates[i] = t
		maxVal = math.Max(maxVal, p.Value)
	}
	if s.Threshold != nil {
		maxVal = math.Max(maxVal, *s.Threshold)
	}
	faces, err := loadFaces()
	if err != nil {
		return nil, err
	}

	step, top := niceAxis(maxVal * 1.15)
	short := n < shortHistory
	ax := axis{top: top, n: n, short: short}
	cv := newCanvas(pal.bg)

	ri, ci := indexOf(s.Points, s.ReportDate), indexOf(s.Points, s.ComparedTo)
	if ri < 0 {
		ri = n - 1
	}

	// Gridlines, each with its value. The 0 line is the baseline.
	intervals := int(math.Ceil(top/step - 1e-9))
	for k := 0; k <= intervals; k++ {
		v := roundTo(float64(k)*step, 6)
		y := ax.y(v)
		cv.paint(pal.grid, func(r *vector.Rasterizer) {
			addRect(r, plotLeft, y-1, rightX, y+1)
		})
		cv.drawRight(faces.axis, pal.axis, strconv.FormatFloat(v, 'f', -1, 64)+"%", plotLeft-16, y+10)
	}

	// X labels. A long history is labelled with month names at each month boundary,
	// so a tick never carries a year. A short history is labelled with each reading's
	// own day, thinned to at most five.
	for _, l := range axisLabels(dates, short, ax, faces.axis) {
		cv.drawCentered(faces.axis, pal.axis, l.text, l.x, labelBaseline)
	}

	// The area under the line, then the line.
	pts := make([]pt, n)
	for i, p := range s.Points {
		pts[i] = pt{ax.x(i), ax.y(p.Value)}
	}
	area := make([]pt, 0, n+2)
	area = append(area, pt{pts[0].x, baselineY})
	area = append(area, pts...)
	area = append(area, pt{pts[n-1].x, baselineY})
	cv.paint(pal.fill, func(r *vector.Rasterizer) { addPoly(r, area) })
	cv.paint(pal.line, func(r *vector.Rasterizer) { addStroke(r, pts, 5) })

	// Short history: a dot on every reading but the report's, which gets its own marker.
	if short {
		for i, p := range pts {
			if i != ri {
				cv.marker(p, 7, 3, pal.line, pal.bg)
			}
		}
	}

	// The latest value sits above and to the left of its marker, kept on the canvas.
	// It is placed before the threshold label, which must keep clear of it.
	label := fmt.Sprintf("%.2f%%", s.Points[ri].Value)
	lw := cv.measure(faces.value, label)
	lx := math.Max(8, math.Min(pts[ri].x-22-lw, float64(Width-8)-lw))
	ly := math.Max(44, pts[ri].y-26)
	latest := box{lx, ly - 26, lx + lw, ly + 8}

	// The threshold: a dashed line, and its label on a paper backing. The label goes
	// at the right end above the line, as the design asks. Where the series crosses
	// that spot it tries the other corners, so the label never hides data.
	if s.Threshold != nil {
		ty := ax.y(*s.Threshold)
		cv.paint(pal.alert, func(r *vector.Rasterizer) {
			for x := float64(plotLeft); x < rightX; x += 26 {
				addRect(r, x, ty-1.5, math.Min(x+14, rightX), ty+1.5)
			}
		})
		text := numStr(*s.Threshold) + "% ALERT LEVEL"
		w := cv.measure(faces.threshold, text)
		markers := []pt{pts[ri]}
		if ci >= 0 {
			markers = append(markers, pts[ci])
		}
		x, baseline := placeThreshold(w, ty, pts, latest, markers)
		bb := box{x - 8, baseline - 17 - 8, x + w + 8, baseline + 8}
		cv.paint(pal.bg, func(r *vector.Rasterizer) {
			addRect(r, bb.x0, bb.y0, bb.x1, bb.y1)
		})
		cv.drawText(faces.threshold, pal.alert, text, x, baseline)
	}

	// Markers: in a long history the compared report's small marker, then the
	// report's large one on top. The short history already has a dot on each reading.
	if !short && ci >= 0 {
		cv.marker(pts[ci], 7, 3, pal.compared, pal.bg)
	}
	cv.marker(pts[ri], 11, 4, pal.marker, pal.bg)

	cv.drawText(faces.value, pal.ink, label, lx, ly)

	// Best compression keeps both charts small enough for the email's size budget. The
	// encoder is deterministic at any level, so the bytes stay stable.
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, cv.img); err != nil {
		return nil, fmt.Errorf("alertchart: encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// labelBaseline is where the x-axis labels sit, and minLabelGap the clear space the
// layout keeps between two of them: 16px at 2x, which is 8px on the shown image.
const (
	labelBaseline = Height - 20
	minLabelGap   = 16
)

// axisLabel is one x-axis label: its text, its centre and the box its ink occupies.
type axisLabel struct {
	text string
	x    float64
	box  box
}

// axisLabels returns the x-axis labels for a chart, in order, with no two boxes
// closer than minLabelGap. A long history labels each month boundary with the month
// name, so no tick carries a year. A short history labels each reading's own day,
// and always keeps the first and the last reading, so the range is named at both
// ends. Intermediate labels that would crowd a neighbour are dropped.
func axisLabels(dates []time.Time, short bool, ax axis, f font.Face) []axisLabel {
	var cands []axisLabel
	if short {
		for i := range dates {
			cands = append(cands, newAxisLabel(dates[i].Format("2 Jan"), ax.x(i), f))
		}
		return selectLabels(cands, true)
	}
	for i := 1; i < len(dates); i++ {
		if dates[i].Year() == dates[i-1].Year() && dates[i].Month() == dates[i-1].Month() {
			continue
		}
		cands = append(cands, newAxisLabel(dates[i].Month().String()[:3], ax.x(i), f))
	}
	return selectLabels(cands, false)
}

// newAxisLabel measures a label centred on x, and records the box it occupies.
// The box spans from the top of the capitals to a little below the baseline.
func newAxisLabel(text string, x float64, f font.Face) axisLabel {
	w := measureFace(f, text)
	return axisLabel{
		text: text,
		x:    x,
		box:  box{x0: x - w/2, y0: labelBaseline - axisSize, x1: x + w/2, y1: labelBaseline + axisSize/4},
	}
}

// selectLabels keeps the first candidate, then each later one that clears the last kept
// label by minLabelGap. With keepLast, the final candidate is always kept when it fits:
// earlier kept labels are dropped from the end until it does, and the first label is
// never dropped. Candidates are in ascending x, so every pair kept is clear.
func selectLabels(cands []axisLabel, keepLast bool) []axisLabel {
	if len(cands) == 0 {
		return nil
	}
	last := len(cands) - 1
	kept := []axisLabel{cands[0]}
	for i := 1; i < len(cands); i++ {
		if keepLast && i == last {
			break
		}
		if clearOf(kept[len(kept)-1], cands[i]) {
			kept = append(kept, cands[i])
		}
	}
	if keepLast && last > 0 {
		for len(kept) > 1 && !clearOf(kept[len(kept)-1], cands[last]) {
			kept = kept[:len(kept)-1]
		}
		if clearOf(kept[len(kept)-1], cands[last]) {
			kept = append(kept, cands[last])
		}
	}
	return kept
}

// clearOf reports whether label b, to the right of a, clears it by minLabelGap.
func clearOf(a, b axisLabel) bool {
	return b.box.x0-a.box.x1 >= minLabelGap
}

// canvas is the image a chart is drawn on. Shapes are painted one colour at a
// time, and each colour has its own rasterizer pass, so the shapes of one colour
// union before they are composited over what is below.
type canvas struct {
	img   *image.RGBA
	layer *vector.Rasterizer
}

func newCanvas(bg color.RGBA) *canvas {
	img := image.NewRGBA(image.Rect(0, 0, Width, Height))
	draw.Draw(img, img.Bounds(), image.NewUniform(bg), image.Point{}, draw.Src)
	return &canvas{img: img, layer: vector.NewRasterizer(Width, Height)}
}

// paint fills the shapes that build adds, in colour c, over what is drawn so far.
func (cv *canvas) paint(c color.Color, build func(*vector.Rasterizer)) {
	cv.layer.Reset(Width, Height)
	build(cv.layer)
	cv.layer.Draw(cv.img, cv.img.Bounds(), image.NewUniform(c), image.Point{})
}

// marker draws a filled circle of radius r with a ring of width ring in the canvas
// colour, so it reads as cut out of the line.
func (cv *canvas) marker(p pt, r, ring float64, c, bg color.RGBA) {
	cv.paint(bg, func(l *vector.Rasterizer) { addCircle(l, p, r+ring) })
	cv.paint(c, func(l *vector.Rasterizer) { addCircle(l, p, r) })
}

// measure is the advance width of s in pixels.
func (cv *canvas) measure(f font.Face, s string) float64 { return measureFace(f, s) }

func measureFace(f font.Face, s string) float64 {
	d := &font.Drawer{Face: f}
	return float64(d.MeasureString(s)) / 64
}

// drawText sets s with its baseline at baseline, from x.
func (cv *canvas) drawText(f font.Face, c color.RGBA, s string, x, baseline float64) {
	d := &font.Drawer{
		Dst:  cv.img,
		Src:  image.NewUniform(c),
		Face: f,
		Dot: fixed.Point26_6{
			X: fixed.Int26_6(math.Round(x * 64)),
			Y: fixed.Int26_6(math.Round(baseline * 64)),
		},
	}
	d.DrawString(s)
}

// drawRight sets s so that it ends at right.
func (cv *canvas) drawRight(f font.Face, c color.RGBA, s string, right, baseline float64) {
	cv.drawText(f, c, s, right-cv.measure(f, s), baseline)
}

// drawCentered sets s so that it is centred on center.
func (cv *canvas) drawCentered(f font.Face, c color.RGBA, s string, center, baseline float64) {
	cv.drawText(f, c, s, center-cv.measure(f, s)/2, baseline)
}

type pt struct{ x, y float64 }

// axis maps data to canvas pixels. A long history runs edge to edge. A short one
// is spread across the plot, with half a step of padding at each end, so the first
// and last dots are not on the frame.
type axis struct {
	top   float64
	n     int
	short bool
}

func (a axis) x(i int) float64 {
	if a.short {
		return plotLeft + float64((float64(i)+0.5)*float64(plotW)/float64(a.n))
	}
	return plotLeft + float64(float64(i)*float64(plotW)/float64(a.n-1))
}

func (a axis) y(v float64) float64 {
	return baselineY - float64(v/a.top*float64(plotH))
}

var niceMultiples = []float64{1, 2, 2.5, 5, 10}

// niceAxis picks the step and the top of the value axis for a maximum. Every step
// is 1, 2, 2.5 or 5 times a power of ten. The one that gives about four or five
// intervals is chosen, and the top is rounded up to a whole number of steps.
func niceAxis(maxVal float64) (step, top float64) {
	if maxVal <= 0 {
		maxVal = 1
	}
	mag := math.Pow(10, math.Floor(math.Log10(maxVal/4.5)))
	bestDiff := math.Inf(1)
	for _, m := range niceMultiples {
		s := mag * m
		n := math.Ceil(maxVal/s - 1e-9)
		if diff := math.Abs(n - 4.5); diff < bestDiff {
			bestDiff, step = diff, s
		}
	}
	top = math.Ceil(maxVal/step-1e-9) * step
	return step, top
}

func roundTo(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

// numStr formats a number without trailing zeros: 10 and 2.5, never 10.00.
func numStr(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func indexOf(points []Point, date string) int {
	if date == "" {
		return -1
	}
	for i, p := range points {
		if p.Date == date {
			return i
		}
	}
	return -1
}

// addRect adds an axis-aligned rectangle.
func addRect(r *vector.Rasterizer, x0, y0, x1, y1 float64) {
	addPoly(r, []pt{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}})
}

// addCircle adds a circle as a 72-sided polygon.
func addCircle(r *vector.Rasterizer, c pt, rad float64) {
	const n = 72
	ps := make([]pt, n)
	for i := range ps {
		a := 2 * math.Pi * float64(i) / n
		ps[i] = pt{c.x + float64(rad*math.Cos(a)), c.y + float64(rad*math.Sin(a))}
	}
	addPoly(r, ps)
}

// addPoly adds a closed polygon. The rasterizer sums signed area, so shapes only
// union correctly when they all wind the same way. Every polygon is normalised to
// positive winding here, and the caller's slice is not modified.
func addPoly(r *vector.Rasterizer, ps []pt) {
	cw := make([]pt, len(ps))
	copy(cw, ps)
	area := 0.0
	for i := range cw {
		j := (i + 1) % len(cw)
		area += float64(cw[i].x*cw[j].y) - float64(cw[j].x*cw[i].y)
	}
	if area < 0 {
		for i, j := 0, len(cw)-1; i < j; i, j = i+1, j-1 {
			cw[i], cw[j] = cw[j], cw[i]
		}
	}
	r.MoveTo(float32(cw[0].x), float32(cw[0].y))
	for _, p := range cw[1:] {
		r.LineTo(float32(p.x), float32(p.y))
	}
	r.ClosePath()
}

// addStroke adds a polyline of the given width with round joins and caps: a quad
// per segment and a disc at every vertex.
func addStroke(r *vector.Rasterizer, ps []pt, width float64) {
	hw := width / 2
	for i := 0; i+1 < len(ps); i++ {
		a, b := ps[i], ps[i+1]
		dx, dy := b.x-a.x, b.y-a.y
		l := math.Hypot(dx, dy)
		if l == 0 {
			continue
		}
		nx, ny := float64(-dy/l*hw), float64(dx/l*hw)
		addPoly(r, []pt{
			{a.x + nx, a.y + ny}, {b.x + nx, b.y + ny},
			{b.x - nx, b.y - ny}, {a.x - nx, a.y - ny},
		})
	}
	for _, p := range ps {
		addCircle(r, p, hw)
	}
}

// box is an axis-aligned rectangle in canvas pixels.
type box struct{ x0, y0, x1, y1 float64 }

// placeThreshold returns the left edge and baseline of the threshold label of
// width w, sitting on the alert level at ty. It tries the right end above the line
// first, then the left end above, then the right and left below. The first spot
// clear of the series, the latest value and the markers wins. When none is clear
// it keeps the first.
func placeThreshold(w, ty float64, series []pt, latest box, markers []pt) (x, baseline float64) {
	const (
		pad    = 8  // clearance around the label and the series line
		radius = 16 // a marker's disc, with its ring
		half   = 8  // the label's backing, above and below its baseline
	)
	candidates := [][2]float64{
		{float64(rightX-8) - w, ty - 14},
		{float64(plotLeft + 8), ty - 14},
		{float64(rightX-8) - w, ty + 30},
		{float64(plotLeft + 8), ty + 30},
	}
	samples := sampleLine(series)
	for _, c := range candidates {
		b := box{c[0] - 8, c[1] - 17 - half, c[0] + w + 8, c[1] + half}
		if !b.hits(latest, pad) && !anyPointIn(samples, b, pad) && !anyCircleHits(markers, b, radius) {
			return c[0], c[1]
		}
	}
	return candidates[0][0], candidates[0][1]
}

// sampleLine returns points along the polyline roughly every two pixels, so a
// box test cannot step over a thin line between two readings.
func sampleLine(ps []pt) []pt {
	var out []pt
	for i := 0; i+1 < len(ps); i++ {
		a, b := ps[i], ps[i+1]
		n := int(math.Max(1, math.Ceil(math.Hypot(b.x-a.x, b.y-a.y)/2)))
		for k := 0; k <= n; k++ {
			t := float64(k) / float64(n)
			out = append(out, pt{a.x + float64((b.x-a.x)*t), a.y + float64((b.y-a.y)*t)})
		}
	}
	return out
}

func (b box) hits(o box, pad float64) bool {
	return b.x0 < o.x1+pad && o.x0 < b.x1+pad && b.y0 < o.y1+pad && o.y0 < b.y1+pad
}

func anyPointIn(ps []pt, b box, pad float64) bool {
	for _, p := range ps {
		if p.x >= b.x0-pad && p.x <= b.x1+pad && p.y >= b.y0-pad && p.y <= b.y1+pad {
			return true
		}
	}
	return false
}

func anyCircleHits(cs []pt, b box, r float64) bool {
	for _, c := range cs {
		nx := math.Max(b.x0, math.Min(c.x, b.x1))
		ny := math.Max(b.y0, math.Min(c.y, b.y1))
		if math.Hypot(c.x-nx, c.y-ny) < r {
			return true
		}
	}
	return false
}

// dateLayout is the report date format the spec uses.
const dateLayout = "2006-01-02"
