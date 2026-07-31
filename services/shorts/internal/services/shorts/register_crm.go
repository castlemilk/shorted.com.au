package shorts

// The per-politician CRM handlers. OPERATOR ONLY — same gate as the securities
// console: VISIBILITY_PRIVATE + required_role="admin" in the proto AND listed in
// internalOnlyMethods, because the admin role is auto-granted from an email
// allowlist and that alone is not a boundary.
//
// THE CURATOR'S IDENTITY COMES FROM THE REQUEST HEADER, never the body. It ends
// up in curated_by / merged_by, which is the evidence a human made the call; a
// body-supplied identity is one the caller chose for themselves.

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	registerreviewv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/registerreview/v1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

var factActionWire = map[registerreviewv1.FactAction]string{
	registerreviewv1.FactAction_FACT_ACTION_AMEND:     "amend",
	registerreviewv1.FactAction_FACT_ACTION_SUPPRESS:  "suppress",
	registerreviewv1.FactAction_FACT_ACTION_REINSTATE: "reinstate",
}

func profileSummaryProto(r *shortsstore.PoliticianProfileSummaryRow) *registerreviewv1.PoliticianProfileSummary {
	if r == nil {
		return nil
	}
	return &registerreviewv1.PoliticianProfileSummary{
		Slug: r.Slug, DisplayName: r.DisplayName, PartyAb: r.PartyAb,
		Chamber: r.Chamber, Division: r.Division, StateCode: r.StateCode,
		AphPhid: r.APHPHID, PhotoUrl: r.PhotoURL,
		DeclaredListedCount: r.DeclaredListedCount, StatementCount: r.StatementCount,
		HasDuplicate: r.HasDuplicate, CuratedFieldCount: r.CuratedFieldCount,
	}
}

func profileFactProto(f *shortsstore.ProfileFactRow) *registerreviewv1.ProfileFact {
	if f == nil {
		return nil
	}
	return &registerreviewv1.ProfileFact{
		Field: f.Field, Ordinal: f.Ordinal, ResolvedText: f.ResolvedText,
		MachineText: f.MachineText, IsCurated: f.IsCurated, CuratedBy: f.CuratedBy,
		SourceKey: f.SourceKey, SourceUrl: f.SourceURL, SourceLicence: f.SourceLicence,
	}
}

func (s *ShortsServer) ListPoliticianProfiles(
	ctx context.Context,
	req *connect.Request[registerreviewv1.ListPoliticianProfilesRequest],
) (*connect.Response[registerreviewv1.ListPoliticianProfilesResponse], error) {
	rows, total, dupes, err := s.store.ListPoliticianProfiles(
		req.Msg.GetQuery(), req.Msg.GetLimit(), req.Msg.GetOffset(), req.Msg.GetDuplicatesOnly())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &registerreviewv1.ListPoliticianProfilesResponse{Total: total, DuplicateCount: dupes}
	for _, r := range rows {
		out.Profiles = append(out.Profiles, profileSummaryProto(r))
	}
	return connect.NewResponse(out), nil
}

func (s *ShortsServer) GetPoliticianProfile(
	ctx context.Context,
	req *connect.Request[registerreviewv1.GetPoliticianProfileRequest],
) (*connect.Response[registerreviewv1.GetPoliticianProfileResponse], error) {
	p, err := s.store.GetPoliticianProfile(req.Msg.GetSlug())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	out := &registerreviewv1.GetPoliticianProfileResponse{
		Profile:        profileSummaryProto(p.Summary),
		PhotoUrl:       p.PhotoURL,
		PhotoLicence:   p.PhotoLicence,
		PhotoAuthor:    p.PhotoAuthor,
		PhotoSourceUrl: p.PhotoSourceURL,
	}
	for _, t := range p.Terms {
		out.Terms = append(out.Terms, &registerreviewv1.PoliticianTermSummary{
			Parliament: t.Parliament, Chamber: t.Chamber, Division: t.Division,
			StateCode: t.StateCode, PartyAb: t.PartyAb,
		})
	}
	for _, f := range p.Facts {
		out.Facts = append(out.Facts, profileFactProto(f))
	}
	for _, d := range p.Duplicates {
		out.Duplicates = append(out.Duplicates, &registerreviewv1.DuplicateCandidate{
			Slug: d.Slug, DisplayName: d.DisplayName, StatementCount: d.StatementCount,
			DeclaredListedCount: d.DeclaredListedCount, AphPhid: d.APHPHID,
		})
	}
	return connect.NewResponse(out), nil
}

func (s *ShortsServer) CuratePoliticianFact(
	ctx context.Context,
	req *connect.Request[registerreviewv1.CuratePoliticianFactRequest],
) (*connect.Response[registerreviewv1.CuratePoliticianFactResponse], error) {
	action, ok := factActionWire[req.Msg.GetAction()]
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("action is required and must be one of the FactAction values"))
	}
	curator := reviewerFromHeaders(req.Header())
	if curator == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("no curator identity on the request"))
	}

	f, err := s.store.CuratePoliticianFact(req.Msg.GetSlug(), req.Msg.GetField(),
		req.Msg.GetOrdinal(), action, req.Msg.GetCuratedText(),
		req.Msg.GetRationale(), req.Msg.GetEvidenceUrl(), curator)
	if err != nil {
		if errors.Is(err, shortsstore.ErrCurationNeedsReason) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerreviewv1.CuratePoliticianFactResponse{
		Fact: profileFactProto(f),
	}), nil
}

func (s *ShortsServer) SetPoliticianPhoto(
	ctx context.Context,
	req *connect.Request[registerreviewv1.SetPoliticianPhotoRequest],
) (*connect.Response[registerreviewv1.SetPoliticianPhotoResponse], error) {
	curator := reviewerFromHeaders(req.Header())
	if curator == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("no curator identity on the request"))
	}

	if err := s.store.SetPoliticianPhoto(req.Msg.GetSlug(), req.Msg.GetPhotoUrl(),
		req.Msg.GetPhotoLicence(), req.Msg.GetPhotoAuthor(),
		req.Msg.GetPhotoSourceUrl(), curator); err != nil {
		if errors.Is(err, shortsstore.ErrPhotoNeedsAttribution) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerreviewv1.SetPoliticianPhotoResponse{
		PhotoUrl:       req.Msg.GetPhotoUrl(),
		PhotoLicence:   req.Msg.GetPhotoLicence(),
		PhotoAuthor:    req.Msg.GetPhotoAuthor(),
		PhotoSourceUrl: req.Msg.GetPhotoSourceUrl(),
	}), nil
}

func (s *ShortsServer) MergePoliticians(
	ctx context.Context,
	req *connect.Request[registerreviewv1.MergePoliticiansRequest],
) (*connect.Response[registerreviewv1.MergePoliticiansResponse], error) {
	curator := reviewerFromHeaders(req.Header())
	if curator == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("no curator identity on the request"))
	}

	moved, err := s.store.MergePoliticians(req.Msg.GetKeepSlug(), req.Msg.GetMergeSlug(),
		req.Msg.GetEvidence(), curator)
	if err != nil {
		if errors.Is(err, shortsstore.ErrMergeNeedsEvidence) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&registerreviewv1.MergePoliticiansResponse{
		KeepSlug: req.Msg.GetKeepSlug(), MergeSlug: req.Msg.GetMergeSlug(),
		StatementsMoved: moved,
	}), nil
}
