// Package alertchart renders the short-position chart an alert email carries
// inline. It is pure Go, so the PNG is the same bytes on every host: the paths
// come from golang.org/x/image/vector and the labels from IBM Plex Mono, which is
// embedded rather than read from the system.
//
// The canvas is 2x the size it is shown at (1104x440 for 552x220), so the email
// stays sharp on high-density screens. Render is deterministic: the same Spec
// always produces the same bytes.
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
	Width      = 1104
	Height     = 440
	plotLeft   = 92
	plotRight  = 36
	plotTop    = 44
	plotBottom = 60
	plotW      = Width - plotLeft - plotRight
	plotH      = Height - plotTop - plotBottom
	baselineY  = Height - plotBottom
	rightX     = Width - plotRight
)

// MinPoints is the fewest readings a chart draws. Fewer than this and a line
// says nothing, so Render returns ErrTooFewPoints and the email skips the chart.
const MinPoints = 3

// ErrTooFewPoints is returned for a series shorter than MinPoints.
var ErrTooFewPoints = errors.New("alertchart: at least three points are needed")

// Palette: the brand tokens from DESIGN.md, as the chart uses them.
var (
	colPaper     = color.RGBA{0xFD, 0xFD, 0xFC, 0xFF}
	colGrid      = color.RGBA{0xED, 0xE9, 0xE4, 0xFF}
	colMuted     = color.RGBA{0x72, 0x62, 0x5A, 0xFF}
	colInk       = color.RGBA{0x48, 0x39, 0x32, 0xFF}
	colRust      = color.RGBA{0xD1, 0x6A, 0x47, 0xFF}
	colRustFill  = color.NRGBA{0xD1, 0x6A, 0x47, 36} // about 14% alpha
	colBurntAmbr = color.RGBA{0x9E, 0x52, 0x10, 0xFF}
)

// Text sizes, in pixels at 2x.
const (
	axisSize    = 22
	thresholdSz = 20
	valueSize   = 26
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
	if fs.threshold, err = mk(reg, thresholdSz); err != nil {
		return faceSet{}, err
	}
	if fs.value, err = mk(semi, valueSize); err != nil {
		return faceSet{}, err
	}
	return fs, nil
})

// Render draws the chart as a PNG. Every date is validated before anything is
// drawn, so a malformed row fails the render rather than drawing a wrong axis.
func Render(s Spec) ([]byte, error) {
	if len(s.Points) < MinPoints {
		return nil, ErrTooFewPoints
	}
	maxVal := 0.0
	for i, p := range s.Points {
		if _, err := time.Parse("2006-01-02", p.Date); err != nil {
			return nil, fmt.Errorf("alertchart: point %d: bad date %q: %w", i, p.Date, err)
		}
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
	ax := axis{top: top, n: len(s.Points)}
	cv := newCanvas()

	// Gridlines, each with its value. The 0 line is the baseline.
	intervals := int(math.Ceil(top/step - 1e-9))
	for k := 0; k <= intervals; k++ {
		v := roundTo(float64(k)*step, 6)
		y := float64(ax.y(v))
		cv.paint(colGrid, func(r *vector.Rasterizer) {
			addRect(r, plotLeft, y-1, rightX, y+1)
		})
		cv.drawRight(faces.axis, colMuted, strconv.FormatFloat(v, 'f', -1, 64)+"%", plotLeft-14, int(y)+8)
	}

	// Month ticks at each month boundary. The first tick and each January carry
	// the year, so the reader always knows which year they are reading.
	firstTick := true
	for i := 1; i < len(s.Points); i++ {
		cur, _ := time.Parse("2006-01-02", s.Points[i].Date)
		prev, _ := time.Parse("2006-01-02", s.Points[i-1].Date)
		if cur.Year() == prev.Year() && cur.Month() == prev.Month() {
			continue
		}
		label := cur.Month().String()[:3]
		if firstTick || cur.Month() == time.January {
			label += " " + cur.Format("06")
		}
		firstTick = false
		cv.drawCentered(faces.axis, colMuted, label, int(ax.x(i)), Height-18)
	}

	// The area under the line, then the line.
	pts := make([]pt, len(s.Points))
	for i, p := range s.Points {
		pts[i] = pt{ax.x(i), ax.y(p.Value)}
	}
	area := make([]pt, 0, len(pts)+2)
	area = append(area, pt{pts[0].x, baselineY})
	area = append(area, pts...)
	area = append(area, pt{pts[len(pts)-1].x, baselineY})
	cv.paint(colRustFill, func(r *vector.Rasterizer) { addPoly(r, area) })
	cv.paint(colRust, func(r *vector.Rasterizer) { addStroke(r, pts, 4) })

	// The latest value sits above and to the left of its marker, kept on the canvas.
	// It is placed first, because the threshold label must keep clear of it.
	ri, ci := indexOf(s.Points, s.ReportDate), indexOf(s.Points, s.ComparedTo)
	if ri < 0 {
		ri = len(pts) - 1
	}
	label := fmt.Sprintf("%.2f%%", s.Points[ri].Value)
	lw := cv.measure(faces.value, label)
	lx := math.Max(8, math.Min(float64(pts[ri].x)-18-lw, float64(Width-8)-lw))
	ly := math.Max(30, float64(pts[ri].y)-22)
	latest := box{lx, ly - 20, lx + lw, ly + 6}

	// The threshold: a dashed line, and its label on a paper backing. The label
	// goes at the right end above the line, as the design asks. Where the series
	// crosses that spot it tries the other corners, so the label never hides data.
	if s.Threshold != nil {
		ty := float64(ax.y(*s.Threshold))
		cv.paint(colBurntAmbr, func(r *vector.Rasterizer) {
			for x := float64(plotLeft); x < rightX; x += 22 {
				addRect(r, x, ty-1.5, math.Min(x+12, rightX), ty+1.5)
			}
		})
		text := numStr(*s.Threshold) + "% ALERT LEVEL"
		w := cv.measure(faces.threshold, text)
		markers := []pt{pts[ri]}
		if ci >= 0 {
			markers = append(markers, pts[ci])
		}
		x, baseline := placeThreshold(w, ty, pts, latest, markers)
		bb := box{x - 6, baseline - 14 - 6, x + w + 6, baseline + 6}
		cv.paint(colPaper, func(r *vector.Rasterizer) {
			addRect(r, bb.x0, bb.y0, bb.x1, bb.y1)
		})
		cv.drawText(faces.threshold, colBurntAmbr, text, x, baseline)
	}

	// Markers: the compared report first, then the report on top of it.
	if ci >= 0 {
		cv.marker(pts[ci], 6, 3, colMuted)
	}
	cv.marker(pts[ri], 9, 4, colBurntAmbr)

	cv.drawText(faces.value, colInk, label, lx, ly)

	var buf bytes.Buffer
	if err := png.Encode(&buf, cv.img); err != nil {
		return nil, fmt.Errorf("alertchart: encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// canvas is the image a chart is drawn on. Shapes are painted one colour at a
// time, and each colour has its own rasterizer pass, so the shapes of one colour
// union before they are composited over what is below.
type canvas struct {
	img   *image.RGBA
	layer *vector.Rasterizer
}

func newCanvas() *canvas {
	img := image.NewRGBA(image.Rect(0, 0, Width, Height))
	draw.Draw(img, img.Bounds(), image.NewUniform(colPaper), image.Point{}, draw.Src)
	return &canvas{img: img, layer: vector.NewRasterizer(Width, Height)}
}

// paint fills the shapes that build adds, in colour c, over what is drawn so far.
func (cv *canvas) paint(c color.Color, build func(*vector.Rasterizer)) {
	cv.layer.Reset(Width, Height)
	build(cv.layer)
	cv.layer.Draw(cv.img, cv.img.Bounds(), image.NewUniform(c), image.Point{})
}

// marker draws a filled circle of radius r with a paper ring of width ring.
func (cv *canvas) marker(p pt, r, ring float64, c color.RGBA) {
	cv.paint(colPaper, func(l *vector.Rasterizer) { addCircle(l, p, r+ring) })
	cv.paint(c, func(l *vector.Rasterizer) { addCircle(l, p, r) })
}

// measure is the advance width of s in pixels.
func (cv *canvas) measure(f font.Face, s string) float64 {
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
func (cv *canvas) drawRight(f font.Face, c color.RGBA, s string, right float64, baseline int) {
	cv.drawText(f, c, s, right-cv.measure(f, s), float64(baseline))
}

// drawCentered sets s so that it is centred on center.
func (cv *canvas) drawCentered(f font.Face, c color.RGBA, s string, center int, baseline int) {
	cv.drawText(f, c, s, float64(center)-cv.measure(f, s)/2, float64(baseline))
}

type pt struct{ x, y float64 }

// box is an axis-aligned rectangle in canvas pixels.
type box struct{ x0, y0, x1, y1 float64 }

// placeThreshold returns the left edge and baseline of the threshold label of
// width w, sitting on the alert level at ty. It tries the right end above the line
// first, then the left end above, then the right and left below. The first spot
// clear of the series, the latest value and the markers wins. When none is clear
// it keeps the first.
func placeThreshold(w, ty float64, series []pt, latest box, markers []pt) (x, baseline float64) {
	const (
		pad    = 6  // clearance around the label and the series line
		radius = 14 // a marker's disc, with its ring
	)
	candidates := [][2]float64{
		{float64(rightX-8) - w, ty - 12},
		{float64(plotLeft + 8), ty - 12},
		{float64(rightX-8) - w, ty + 26},
		{float64(plotLeft + 8), ty + 26},
	}
	samples := sampleLine(series)
	for _, c := range candidates {
		b := box{c[0] - 6, c[1] - 14 - 6, c[0] + w + 6, c[1] + 6}
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
			out = append(out, pt{a.x + (b.x-a.x)*t, a.y + (b.y-a.y)*t})
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

// axis maps data to canvas pixels.
type axis struct {
	top float64
	n   int
}

func (a axis) x(i int) float64 {
	return plotLeft + float64(i)*float64(plotW)/float64(a.n-1)
}

func (a axis) y(v float64) float64 {
	return baselineY - v/a.top*float64(plotH)
}

var niceMultiples = []float64{1, 2, 2.5, 5, 10}

// niceAxis picks the step and the top of the value axis for a maximum. Every step
// is 1, 2, 2.5 or 5 times a power of ten: the one that gives about four or five
// gridlines is chosen, and the top is rounded up to a whole number of steps.
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
		ps[i] = pt{c.x + rad*math.Cos(a), c.y + rad*math.Sin(a)}
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
		area += cw[i].x*cw[j].y - cw[j].x*cw[i].y
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
		nx, ny := -dy/l*hw, dx/l*hw
		addPoly(r, []pt{
			{a.x + nx, a.y + ny}, {b.x + nx, b.y + ny},
			{b.x - nx, b.y - ny}, {a.x - nx, a.y - ny},
		})
	}
	for _, p := range ps {
		addCircle(r, p, hw)
	}
}
