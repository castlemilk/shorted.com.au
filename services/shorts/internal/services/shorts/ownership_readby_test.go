package shorts

import (
	"testing"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
)

// A notice read by a model (migration 000154) is served as "model"; a row read without
// the column is the parser's, never an empty mark. The overview counts the model's
// notices within the parsed total.
func TestReadByIsServedAndDefaultsToParser(t *testing.T) {
	assert.Equal(t, "parser", readByOrParser(""))
	assert.Equal(t, "parser", readByOrParser("parser"))
	assert.Equal(t, "model", readByOrParser("model"))

	d := &ownershipData{}
	model := d.noticeProto(shortsstore.SubstantialNoticeRow{StockCode: "ZIP", AnnouncedOn: "2026-10-16", ReadBy: "model"})
	assert.Equal(t, "model", model.GetReadBy())
	parsed := d.noticeProto(shortsstore.SubstantialNoticeRow{StockCode: "ZIP", AnnouncedOn: "2026-10-16", ReadBy: "parser"})
	assert.Equal(t, "parser", parsed.GetReadBy())
	unset := d.noticeProto(shortsstore.SubstantialNoticeRow{StockCode: "ZIP", AnnouncedOn: "2026-10-16"})
	assert.Equal(t, "parser", unset.GetReadBy(), "a row read without the column reads as the parser's")
}

func TestOverviewCountsModelReadNoticesWithinTheParsedTotal(t *testing.T) {
	fixture := ownershipFixture()
	fixture.stats.ReadByModel = 2
	ov := buildOwnershipOverview(newOwnershipUniverse(fixture, nil, nil, ownershipTestNow))
	assert.Equal(t, int32(2), ov.GetNoticesReadByModel())
	assert.Equal(t, int32(9), ov.GetNoticesParsed(), "model reads are already inside the parsed count")

	none := ownershipFixture()
	ov = buildOwnershipOverview(newOwnershipUniverse(none, nil, nil, ownershipTestNow))
	assert.Equal(t, int32(0), ov.GetNoticesReadByModel(), "no model reads, or a schema without 000154")
}
