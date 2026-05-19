package shorts

import (
	"context"
	"encoding/json"
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
		if ts, ok := parseTimestamp(*t.PublishedAt); ok {
			out.PublishedAt = timestamppb.New(ts)
		}
	}
	if t.CreatedAt != "" {
		if ts, ok := parseTimestamp(t.CreatedAt); ok {
			out.CreatedAt = timestamppb.New(ts)
		}
	}
	if t.HeroImageURL != nil {
		out.HeroImageUrl = *t.HeroImageURL
	}
	if t.TweetPublishedAt != nil && *t.TweetPublishedAt != "" {
		if ts, ok := parseTimestamp(*t.TweetPublishedAt); ok {
			out.TweetPublishedAt = timestamppb.New(ts)
		}
	}
	if len(t.InlineImages) > 0 {
		var imgs []shortsstore.InlineImage
		if err := json.Unmarshal(t.InlineImages, &imgs); err == nil {
			out.InlineImages = make([]*shortsv1alpha1.InlineImage, len(imgs))
			for i, img := range imgs {
				out.InlineImages[i] = &shortsv1alpha1.InlineImage{
					Url:   img.URL,
					Topic: img.Topic,
					Alt:   img.Alt,
				}
			}
		}
	}
	return out
}

// ===== Admin handlers =====

func (s *ShortsServer) ListEditorialTakesAdmin(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListEditorialTakesAdminRequest],
) (*connect.Response[shortsv1alpha1.ListEditorialTakesAdminResponse], error) {
	limit := req.Msg.GetLimit()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	filter := ""
	switch req.Msg.GetStatusFilter() {
	case shortsv1alpha1.TakeStatus_TAKE_STATUS_DRAFT:
		filter = "draft"
	case shortsv1alpha1.TakeStatus_TAKE_STATUS_PUBLISHED:
		filter = "published"
	case shortsv1alpha1.TakeStatus_TAKE_STATUS_TWEETED:
		filter = "tweeted"
	}
	takes, total, err := s.store.ListEditorialTakesAdmin(limit, req.Msg.GetOffset(), filter)
	if err != nil {
		s.logger.Errorf("ListEditorialTakesAdmin: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list takes"))
	}
	out := make([]*shortsv1alpha1.EditorialTake, len(takes))
	for i, t := range takes {
		out[i] = convertEditorialTake(t)
	}
	return connect.NewResponse(&shortsv1alpha1.ListEditorialTakesAdminResponse{
		Takes: out, TotalCount: int32(total),
	}), nil
}

func (s *ShortsServer) PublishEditorialTake(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.PublishEditorialTakeRequest],
) (*connect.Response[shortsv1alpha1.PublishEditorialTakeResponse], error) {
	if req.Msg.GetSlug() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug required"))
	}
	take, err := s.store.PublishEditorialTake(req.Msg.GetSlug())
	if err != nil {
		s.logger.Errorf("PublishEditorialTake: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to publish take"))
	}
	return connect.NewResponse(&shortsv1alpha1.PublishEditorialTakeResponse{
		Take: convertEditorialTake(take),
	}), nil
}

func (s *ShortsServer) UpdateEditorialTake(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.UpdateEditorialTakeRequest],
) (*connect.Response[shortsv1alpha1.UpdateEditorialTakeResponse], error) {
	if req.Msg.GetSlug() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug required"))
	}
	upd := shortsstore.EditorialTakeUpdate{}
	if v := req.Msg.GetBodyMd(); v != "" {
		upd.BodyMD = &v
	}
	if v := req.Msg.GetHeadline(); v != "" {
		upd.Headline = &v
	}
	if v := req.Msg.GetHeroImageUrl(); v != "" {
		upd.HeroImageURL = &v
	}
	if v := req.Msg.GetSentiment(); v != "" {
		upd.Sentiment = &v
	}
	take, err := s.store.UpdateEditorialTake(req.Msg.GetSlug(), upd)
	if err != nil {
		s.logger.Errorf("UpdateEditorialTake: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to update take"))
	}
	return connect.NewResponse(&shortsv1alpha1.UpdateEditorialTakeResponse{
		Take: convertEditorialTake(take),
	}), nil
}

func (s *ShortsServer) DeleteEditorialTake(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.DeleteEditorialTakeRequest],
) (*connect.Response[shortsv1alpha1.DeleteEditorialTakeResponse], error) {
	deleted, err := s.store.DeleteEditorialTake(req.Msg.GetSlug())
	if err != nil {
		s.logger.Errorf("DeleteEditorialTake: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to delete take"))
	}
	return connect.NewResponse(&shortsv1alpha1.DeleteEditorialTakeResponse{Deleted: deleted}), nil
}

func (s *ShortsServer) MarkTakeTweetPublished(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.MarkTakeTweetPublishedRequest],
) (*connect.Response[shortsv1alpha1.MarkTakeTweetPublishedResponse], error) {
	take, err := s.store.MarkTakeTweetPublished(req.Msg.GetSlug())
	if err != nil {
		s.logger.Errorf("MarkTakeTweetPublished: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to mark tweet published"))
	}
	return connect.NewResponse(&shortsv1alpha1.MarkTakeTweetPublishedResponse{
		Take: convertEditorialTake(take),
	}), nil
}

func (s *ShortsServer) ListTweetPublishQueue(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListTweetPublishQueueRequest],
) (*connect.Response[shortsv1alpha1.ListTweetPublishQueueResponse], error) {
	limit := req.Msg.GetLimit()
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	takes, err := s.store.ListTweetPublishQueue(limit)
	if err != nil {
		s.logger.Errorf("ListTweetPublishQueue: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list publish queue"))
	}
	out := make([]*shortsv1alpha1.EditorialTake, len(takes))
	for i, t := range takes {
		out[i] = convertEditorialTake(t)
	}
	return connect.NewResponse(&shortsv1alpha1.ListTweetPublishQueueResponse{Takes: out}), nil
}

// parseTimestamp accepts the formats Postgres TIMESTAMPTZ may serialise
// to a Go string via pgx — RFC3339 (e.g., '2026-05-19T04:03:30Z') OR
// the default pgx textual format with a space separator and offset
// ('2026-05-19 04:03:30.929849+00:00'). Returns false on failure.
func parseTimestamp(s string) (time.Time, bool) {
	formats := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05-07",
		"2006-01-02 15:04:05",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
