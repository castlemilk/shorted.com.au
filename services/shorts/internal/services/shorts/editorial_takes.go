package shorts

import (
	"context"
	"fmt"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// GetEditorialTake fetches a single published Shorted Take by slug.
func (s *ShortsServer) GetEditorialTake(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetEditorialTakeRequest],
) (*connect.Response[shortsv1alpha1.GetEditorialTakeResponse], error) {
	slug := req.Msg.GetSlug()
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug required"))
	}
	take, err := s.store.GetEditorialTake(slug)
	if err != nil {
		s.logger.Errorf("GetEditorialTake: slug=%s err=%v", slug, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get editorial take"))
	}
	if take == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("editorial take not found"))
	}
	return connect.NewResponse(&shortsv1alpha1.GetEditorialTakeResponse{
		Take: convertEditorialTake(take),
	}), nil
}

// ListEditorialTakes returns recent published Takes.
func (s *ShortsServer) ListEditorialTakes(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListEditorialTakesRequest],
) (*connect.Response[shortsv1alpha1.ListEditorialTakesResponse], error) {
	limit := req.Msg.GetLimit()
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	takes, total, err := s.store.ListEditorialTakes(limit, req.Msg.GetOffset(), req.Msg.GetStockCode())
	if err != nil {
		s.logger.Errorf("ListEditorialTakes: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list editorial takes"))
	}
	out := make([]*shortsv1alpha1.EditorialTake, len(takes))
	for i, t := range takes {
		out[i] = convertEditorialTake(t)
	}
	return connect.NewResponse(&shortsv1alpha1.ListEditorialTakesResponse{
		Takes:      out,
		TotalCount: int32(total),
	}), nil
}

func convertEditorialTake(t *shortsstore.EditorialTake) *shortsv1alpha1.EditorialTake {
	out := &shortsv1alpha1.EditorialTake{
		Id:       t.ID,
		Slug:     t.Slug,
		Headline: t.Headline,
		BodyMd:   t.BodyMD,
	}
	if t.StockCode != nil {
		out.StockCode = *t.StockCode
	}
	if t.Sentiment != nil {
		out.Sentiment = *t.Sentiment
	}
	if t.SourceArticleID != nil {
		out.SourceArticleId = *t.SourceArticleID
	}
	if t.SourceURL != nil {
		out.SourceUrl = *t.SourceURL
	}
	if t.SourceName != nil {
		out.SourceName = *t.SourceName
	}
	if t.OGImageURL != nil {
		out.OgImageUrl = *t.OGImageURL
	}
	if t.WordCount != nil {
		out.WordCount = *t.WordCount
	}
	if t.Model != nil {
		out.Model = *t.Model
	}
	if t.PublishedAt != nil && *t.PublishedAt != "" {
		if ts, err := time.Parse(time.RFC3339, *t.PublishedAt); err == nil {
			out.PublishedAt = timestamppb.New(ts)
		}
	}
	if t.CreatedAt != "" {
		if ts, err := time.Parse(time.RFC3339, t.CreatedAt); err == nil {
			out.CreatedAt = timestamppb.New(ts)
		}
	}
	return out
}
