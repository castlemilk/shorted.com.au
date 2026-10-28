package mcp

// admin_crawl.go: authorizing a BrandBrain rig to push housing listings into
// shorted, from the admin connector. Two tools, one scope:
//
//   - housing_crawl_rigs (crawl:authorize, read) lists shorted's allowlist and,
//     given a rig_id, BrandBrain's grant state and whether that rig's row exists
//     and is enabled.
//   - housing_crawl_authorize (crawl:authorize, write) turns a rig on or off on
//     BOTH sides. Each side is independent and both are required for a push:
//     shorted's housing_ingest_rigs row (the ingest's rigGate) and BrandBrain's
//     housing_crawl_v1 operator grant.
//
// The subject a rig pushes under is BrandBrain's workload_subject, and it is
// never derived here. The authorize tool learns it from BrandBrain's GET and then
// writes that exact value to shorted.
//
// Sequencing (enable): GET the grant (404 stops, nothing written), PUT granted=true,
// then upsert the allowlist row. A PUT whose outcome is unknown stops the run before
// shorted is touched.
//
// Sequencing (disable): GET the subject, flip shorted's row first (local, takes effect
// within the ingest's one-minute cache), then PUT granted=false. The PUT is still
// attempted when the shorted write failed. A PUT with an unknown outcome is reported
// as unknown and is never retried here.
//
// Idempotent: a repeat reports "unchanged" on each side it did not change.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
)

// The crawl tool names.
const (
	CrawlRigsTool      = "housing_crawl_rigs"
	CrawlAuthorizeTool = "housing_crawl_authorize"
)

// crawlTimeout bounds one authorize call: at most two BrandBrain requests of 10 s
// each and one short database transaction. Past it the call fails, and any change
// it started is reported as unknown by the outcome it had.
const crawlTimeout = 30 * time.Second

// crawlNoteMax is the longest note the allowlist row accepts.
const crawlNoteMax = 200

var (
	crawlRigIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	// crawlSubjectPattern mirrors the BrandBrain issuer's rig subject: "rig:" plus a rig
	// id matching rigIDPattern (backend/internal/adapters/http/fleet_orchestration_handler.go,
	// rigTokenSubjectPrefix in fleet_handler.go). Anything else is not a rig subject.
	crawlSubjectPattern = regexp.MustCompile(`^rig:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
	crawlEnumPattern    = regexp.MustCompile(`^[a-z_]{1,40}$`)
)

// Outcome words for each side. They are fixed: an agent can branch on them.
const (
	ShortedEnabled    = "enabled"
	ShortedDisabled   = "disabled"
	ShortedUnchanged  = "unchanged"
	ShortedNotPresent = "not_present"
	ShortedFailed     = "failed"

	BrandBrainGranted   = "granted"
	BrandBrainRevoked   = "revoked"
	BrandBrainUnchanged = "unchanged"
	BrandBrainFailed    = "failed"
	BrandBrainUnknown   = "unknown"
	// BrandBrainNotAttempted is a disable by subject: BrandBrain is not called, so its
	// grant is unchanged and the outcome is not known.
	BrandBrainNotAttempted = "not_attempted"
)

// CrawlRigRow is one allowlist row as the read tool returns it. The note is not
// here: it is free text, and this tool returns identifiers, enums, bools and
// timestamps only.
type CrawlRigRow struct {
	Subject   string
	Enabled   bool
	CreatedAt time.Time
}

// CrawlRigStore is the allowlist, as the admin tools need it. The store implements
// it through shortsstore.IngestRigAdminStore; the admin source adapts the types.
type CrawlRigStore interface {
	ListCrawlRigs(ctx context.Context) ([]CrawlRigRow, error)
	CrawlRigState(ctx context.Context, subject string) (present, enabled bool, err error)
	EnableCrawlRig(ctx context.Context, subject string, note *string) (wasEnabled bool, err error)
	DisableCrawlRig(ctx context.Context, subject string) (outcome string, err error)
}

// CrawlGrantClient is the BrandBrain side. *brandbrain.Client implements it.
type CrawlGrantClient interface {
	GetGrant(ctx context.Context, rigID string) (*brandbrain.Grant, error)
	PutGrant(ctx context.Context, rigID string, granted bool, operator string) (*brandbrain.Grant, error)
}

// AdminCrawlOperator is the housing-crawl half of the admin operator. A nil result
// means that half is not wired on this deployment, and the tools say so.
type AdminCrawlOperator interface {
	CrawlRigStore() CrawlRigStore
	// CrawlGrants is nil when BRANDBRAIN_HOUSING_GRANT_TOKEN is unset.
	CrawlGrants() CrawlGrantClient
	// CrawlOperatorEmail is the verified address of the caller, sent to BrandBrain
	// as X-Operator for audit. Empty when it cannot be read.
	CrawlOperatorEmail(ctx context.Context, userID string) string
}

// --- housing_crawl_rigs -------------------------------------------------------

// CrawlRigsInput names an optional rig to look up.
type CrawlRigsInput struct {
	RigID string `json:"rig_id,omitempty" jsonschema:"A BrandBrain rig id, e.g. rig_01. Omit it to list shorted's allowlist only. With it, BrandBrain's grant state for that rig is read too."`
}

// CrawlRigsOutput is the allowlist, and optionally one rig's grant state.
type CrawlRigsOutput struct {
	Rigs  []CrawlRigOut  `json:"rigs" jsonschema:"Every allowlist row, oldest first. Subject, enabled and created_at only; the note is not returned."`
	Grant *CrawlGrantOut `json:"grant,omitempty" jsonschema:"Present only when rig_id was given."`
}

// CrawlRigOut is one allowlist row.
type CrawlRigOut struct {
	Subject   string `json:"subject" jsonschema:"The JWT sub the rig pushes under."`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at" jsonschema:"RFC 3339."`
}

// CrawlGrantOut is BrandBrain's grant state for one rig, and whether shorted's row
// for its workload_subject exists and is enabled.
type CrawlGrantOut struct {
	RigID             string `json:"rig_id"`
	BrandBrain        string `json:"brandbrain" jsonschema:"ok | not_found | rejected | unavailable | invalid | not_configured."`
	Granted           bool   `json:"granted" jsonschema:"BrandBrain's housing_crawl_v1 grant."`
	AdminState        string `json:"admin_state" jsonschema:"BrandBrain's rig admin state, or unknown."`
	PrincipalKind     string `json:"principal_kind" jsonschema:"rig_token | user | none, or unknown."`
	CanMint           bool   `json:"can_mint"`
	CanMintReason     string `json:"can_mint_reason" jsonschema:"ok | user_session | no_rig_token | not_active | no_grant | version_too_old, or unknown."`
	WorkloadSubject   string `json:"workload_subject,omitempty"`
	SubjectRowPresent bool   `json:"subject_row_present" jsonschema:"Whether shorted has an allowlist row for workload_subject."`
	SubjectRowEnabled bool   `json:"subject_row_enabled"`
}

func crawlRigsTool() AdminTool {
	t := AdminTool{Name: CrawlRigsTool, Scope: ScopeCrawlAuthorize}
	t.register = func(server *sdk.Server, op AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "List housing crawl rigs",
			Description: "List shorted's housing crawl allowlist (housing_ingest_rigs): each rig's subject, whether it is enabled and when it was added. " +
				"With rig_id, also read BrandBrain's housing_crawl_v1 grant for that rig and whether shorted's row for its workload_subject is enabled. " +
				"Read-only. Use it before and after housing_crawl_authorize.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, OpenWorldHint: new(true)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in CrawlRigsInput) (*sdk.CallToolResult, CrawlRigsOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, CrawlRigsOutput{}, nil
			}
			ctx, cancel := context.WithTimeout(ctx, crawlTimeout)
			defer cancel()
			out, err := readCrawlRigs(ctx, op, in)
			if err != nil {
				return crawlToolError(err), CrawlRigsOutput{}, nil
			}
			text := fmt.Sprintf("%d allowlist row(s).", len(out.Rigs))
			if out.Grant != nil {
				text += fmt.Sprintf(" BrandBrain for %s: %s.", out.Grant.RigID, out.Grant.BrandBrain)
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

func readCrawlRigs(ctx context.Context, op AdminOperator, in CrawlRigsInput) (CrawlRigsOutput, error) {
	out := CrawlRigsOutput{Rigs: []CrawlRigOut{}}
	if in.RigID != "" && !crawlRigIDPattern.MatchString(in.RigID) {
		return out, errCrawlRigID
	}
	store := op.CrawlRigStore()
	if store == nil {
		return out, errCrawlStoreUnavailable
	}
	rows, err := store.ListCrawlRigs(ctx)
	if err != nil {
		return out, errCrawlStoreRead
	}
	for _, r := range rows {
		out.Rigs = append(out.Rigs, CrawlRigOut{Subject: r.Subject, Enabled: r.Enabled, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339)})
	}
	if in.RigID == "" {
		return out, nil
	}

	grant := &CrawlGrantOut{RigID: in.RigID, BrandBrain: "not_configured", AdminState: "unknown",
		PrincipalKind: "unknown", CanMintReason: "unknown"}
	out.Grant = grant
	client := op.CrawlGrants()
	if client == nil {
		return out, nil
	}
	g, err := client.GetGrant(ctx, in.RigID)
	switch {
	case errors.Is(err, brandbrain.ErrRigNotFound):
		grant.BrandBrain = "not_found"
		return out, nil
	case errors.Is(err, brandbrain.ErrRejected):
		grant.BrandBrain = "rejected"
		return out, nil
	case err != nil:
		grant.BrandBrain = "unavailable"
		return out, nil
	}
	grant.BrandBrain = "ok"
	grant.Granted = g.Granted
	grant.AdminState = closedEnum(g.AdminState)
	grant.PrincipalKind = closedEnum(g.PrincipalKind)
	grant.CanMint = g.CanMint
	grant.CanMintReason = closedEnum(g.CanMintReason)
	if !crawlSubjectPattern.MatchString(g.WorkloadSubject) {
		grant.BrandBrain = "invalid"
		return out, nil
	}
	grant.WorkloadSubject = g.WorkloadSubject
	for _, r := range rows {
		if r.Subject == g.WorkloadSubject {
			grant.SubjectRowPresent = true
			grant.SubjectRowEnabled = r.Enabled
		}
	}
	return out, nil
}

// closedEnum passes a BrandBrain enum through only when it is a plain lower-case
// word. Anything else is "unknown", so an unexpected string never reaches the model.
func closedEnum(s string) string {
	if crawlEnumPattern.MatchString(s) {
		return s
	}
	return "unknown"
}

// --- housing_crawl_authorize --------------------------------------------------

// CrawlAuthorizeInput is closed: any other field is refused by the schema. Exactly one
// of rig_id and subject is required; that is enforced in code, not in the schema.
type CrawlAuthorizeInput struct {
	RigID   string `json:"rig_id,omitempty" jsonschema:"The BrandBrain rig to change, e.g. rig_01 (letters, digits, dot, underscore, hyphen; at most 100). Give exactly one of rig_id or subject. Required to enable."`
	Subject string `json:"subject,omitempty" jsonschema:"Disable only: the rig's workload_subject (rig:<id>), as housing_crawl_rigs lists it. Only shorted's allowlist row is changed, and BrandBrain is not called, so this works while BrandBrain is down. Give exactly one of rig_id or subject. Not valid with enabled=true."`
	Enabled bool   `json:"enabled" jsonschema:"true authorizes the rig on both sides; false revokes it."`
	Note    string `json:"note,omitempty" jsonschema:"Free text stored on shorted's allowlist row, at most 200 characters. Never returned."`
	Confirm bool   `json:"confirm,omitempty" jsonschema:"Must be true to enable a rig. Not needed to disable one."`
}

// CrawlAuthorizeOutput reports each side separately.
type CrawlAuthorizeOutput struct {
	RigID           string   `json:"rig_id"`
	WorkloadSubject string   `json:"workload_subject,omitempty" jsonschema:"The subject both sides were changed for. Empty when it could not be learned."`
	Shorted         string   `json:"shorted" jsonschema:"enabled | disabled | unchanged | not_present | failed."`
	BrandBrain      string   `json:"brandbrain" jsonschema:"granted | revoked | unchanged | failed | unknown | not_attempted. unknown means a PUT timed out or returned a 5xx: the outcome is not known, and nothing was retried. not_attempted means BrandBrain was not called (disable by subject)."`
	CanMint         bool     `json:"can_mint"`
	CanMintReason   string   `json:"can_mint_reason" jsonschema:"BrandBrain's answer after the change, or unknown when no answer came back."`
	NextSteps       []string `json:"next_steps"`
}

func crawlAuthorizeTool() AdminTool {
	t := AdminTool{Name: CrawlAuthorizeTool, Scope: ScopeCrawlAuthorize}
	t.register = func(server *sdk.Server, op AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Authorize a housing crawl rig",
			Description: "Turn a BrandBrain rig's housing crawl on or off on both sides: BrandBrain's housing_crawl_v1 operator grant, and shorted's " +
				"allowlist that admits its listing pushes. Enabling needs confirm=true and runs GET, then PUT, then the shorted write. " +
				"Disabling writes shorted first, then revokes the grant, and still revokes it when shorted fails. " +
				"To cut a rig off when BrandBrain is unreachable, disable by subject (subject from housing_crawl_rigs, enabled=false): only shorted's row is changed. " +
				"Idempotent: repeat it after an unknown outcome. " +
				"Reports each side separately; check housing_crawl_rigs afterwards.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(true)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in CrawlAuthorizeInput) (*sdk.CallToolResult, CrawlAuthorizeOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, CrawlAuthorizeOutput{}, nil
			}
			out, err := authorizeCrawlRig(ctx, op, tokenUserID(req), in)
			if err != nil {
				return crawlToolError(err), CrawlAuthorizeOutput{}, nil
			}
			text := fmt.Sprintf("%s: shorted %s, BrandBrain %s.", out.RigID, out.Shorted, out.BrandBrain)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// authorizeCrawlRig runs the sequence. It returns an error only for a refusal made
// before anything was written. Once a side has been attempted the outcome is
// reported in the output, never as an error, so the model sees what did land.
func authorizeCrawlRig(ctx context.Context, op AdminOperator, userID string, in CrawlAuthorizeInput) (CrawlAuthorizeOutput, error) {
	// Refusals first, before any request leaves this process.
	hasRig, hasSubject := in.RigID != "", in.Subject != ""
	if hasRig == hasSubject {
		return CrawlAuthorizeOutput{}, errCrawlOneTarget
	}
	if hasSubject {
		// A subject names a rig already known to shorted. Only a disable may use it:
		// enabling needs rig_id, so the subject always comes from BrandBrain.
		if in.Enabled {
			return CrawlAuthorizeOutput{}, errCrawlSubjectEnable
		}
		if !crawlSubjectPattern.MatchString(in.Subject) {
			return CrawlAuthorizeOutput{}, errCrawlSubject
		}
	} else if !crawlRigIDPattern.MatchString(in.RigID) {
		return CrawlAuthorizeOutput{}, errCrawlRigID
	}
	if in.Enabled && !in.Confirm {
		return CrawlAuthorizeOutput{}, errCrawlConfirm
	}
	if len(in.Note) > crawlNoteMax {
		return CrawlAuthorizeOutput{}, errCrawlNote
	}
	store := op.CrawlRigStore()
	if store == nil {
		return CrawlAuthorizeOutput{}, errCrawlStoreUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, crawlTimeout)
	defer cancel()

	if hasSubject {
		// The kill switch: shorted's row only. BrandBrain is not needed, so this
		// works with it down or with its token unset.
		return disableCrawlBySubject(ctx, store, in.Subject), nil
	}

	grants := op.CrawlGrants()
	if grants == nil {
		return CrawlAuthorizeOutput{}, errCrawlNotConfigured
	}

	operator := op.CrawlOperatorEmail(ctx, userID)
	var note *string
	if in.Note != "" {
		n := strings.TrimSpace(in.Note)
		note = &n
	}

	if in.Enabled {
		return enableCrawlRig(ctx, store, grants, operator, in.RigID, note)
	}
	return disableCrawlRig(ctx, store, grants, operator, in.RigID)
}

// disableCrawlBySubject flips shorted's row for subject and never calls BrandBrain.
// A missing row is not_present and nothing is written.
func disableCrawlBySubject(ctx context.Context, store CrawlRigStore, subject string) CrawlAuthorizeOutput {
	out := CrawlAuthorizeOutput{WorkloadSubject: subject, Shorted: ShortedFailed,
		BrandBrain: BrandBrainNotAttempted, CanMintReason: "unknown"}
	if outcome, err := store.DisableCrawlRig(ctx, subject); err == nil {
		out.Shorted = outcome
	}
	out.NextSteps = crawlNextSteps(false, out.Shorted, out.BrandBrain, out.CanMintReason, false)
	return out
}

func enableCrawlRig(ctx context.Context, store CrawlRigStore, grants CrawlGrantClient, operator, rigID string, note *string) (CrawlAuthorizeOutput, error) {
	out := CrawlAuthorizeOutput{RigID: rigID, Shorted: ShortedUnchanged, BrandBrain: BrandBrainUnknown, CanMintReason: "unknown"}

	// 1. GET: learns the subject. Nothing is written if this fails.
	before, err := grants.GetGrant(ctx, rigID)
	if err != nil {
		return out, grantReadError(err)
	}
	subject, err := usableSubject(before)
	if err != nil {
		return out, err
	}
	out.WorkloadSubject = subject

	// 2. PUT granted=true. Anything but a confirmed answer stops here, before shorted.
	after, putErr := grants.PutGrant(ctx, rigID, true, operator)
	switch {
	case putErr == nil:
		out.BrandBrain = BrandBrainGranted
		if before.Granted {
			out.BrandBrain = BrandBrainUnchanged
		}
		out.CanMint, out.CanMintReason = after.CanMint, closedEnum(after.CanMintReason)
	case errors.Is(putErr, brandbrain.ErrUnavailable):
		out.BrandBrain = BrandBrainUnknown
		out.NextSteps = crawlNextSteps(true, out.Shorted, out.BrandBrain, "unknown", false)
		return out, nil
	default:
		out.BrandBrain = BrandBrainFailed
		out.NextSteps = crawlNextSteps(true, out.Shorted, out.BrandBrain, "unknown", false)
		return out, nil
	}

	// 3. Shorted's allowlist row, for the subject BrandBrain named.
	wasEnabled, err := store.EnableCrawlRig(ctx, subject, note)
	switch {
	case err != nil:
		out.Shorted = ShortedFailed
	case wasEnabled:
		out.Shorted = ShortedUnchanged
	default:
		out.Shorted = ShortedEnabled
	}
	out.NextSteps = crawlNextSteps(true, out.Shorted, out.BrandBrain, out.CanMintReason, false)
	return out, nil
}

func disableCrawlRig(ctx context.Context, store CrawlRigStore, grants CrawlGrantClient, operator, rigID string) (CrawlAuthorizeOutput, error) {
	out := CrawlAuthorizeOutput{RigID: rigID, Shorted: ShortedFailed, BrandBrain: BrandBrainUnknown, CanMintReason: "unknown"}

	// 1. The subject: BrandBrain is the only source of it. A 404 stops with nothing written.
	before, getErr := grants.GetGrant(ctx, rigID)
	subjectKnown := false
	var subject string
	switch {
	case getErr == nil:
		if s, err := usableSubject(before); err == nil {
			subject, subjectKnown = s, true
			out.WorkloadSubject = s
		}
	case errors.Is(getErr, brandbrain.ErrRigNotFound):
		return out, errCrawlRigNotFound
	}

	// 2. Shorted first: the local flip takes effect at the ingest's next allowlist read.
	if subjectKnown {
		outcome, err := store.DisableCrawlRig(ctx, subject)
		if err == nil {
			out.Shorted = outcome
		}
	}

	// 3. The grant revoke is attempted whatever happened to shorted. Revoking more is
	//    never the unsafe direction.
	after, putErr := grants.PutGrant(ctx, rigID, false, operator)
	switch {
	case putErr == nil:
		out.BrandBrain = BrandBrainRevoked
		if getErr == nil && !before.Granted {
			out.BrandBrain = BrandBrainUnchanged
		}
		out.CanMint, out.CanMintReason = after.CanMint, closedEnum(after.CanMintReason)
	case errors.Is(putErr, brandbrain.ErrUnavailable):
		out.BrandBrain = BrandBrainUnknown
	case errors.Is(putErr, brandbrain.ErrRigNotFound):
		out.BrandBrain = BrandBrainFailed
	default:
		out.BrandBrain = BrandBrainFailed
	}

	out.NextSteps = crawlNextSteps(false, out.Shorted, out.BrandBrain, out.CanMintReason, !subjectKnown)
	return out, nil
}

// grantReadError maps a failed GET for the enable path. None of these wrote anything.
func grantReadError(err error) error {
	switch {
	case errors.Is(err, brandbrain.ErrRigNotFound):
		return errCrawlRigNotFound
	case errors.Is(err, brandbrain.ErrRejected):
		return errCrawlBrandBrainRejected
	default:
		return errCrawlBrandBrainUnavailable
	}
}

// usableSubject returns BrandBrain's workload_subject when it is a value shorted can
// hold. It is never derived here.
func usableSubject(g *brandbrain.Grant) (string, error) {
	if g == nil || !crawlSubjectPattern.MatchString(g.WorkloadSubject) {
		return "", errCrawlNoSubject
	}
	return g.WorkloadSubject, nil
}

// crawlNextSteps is the closed, generated guidance. It is text the model can act
// on; it never echoes a BrandBrain string.
func crawlNextSteps(enabling bool, shorted, bbState, mintReason string, subjectUnknown bool) []string {
	var steps []string
	if subjectUnknown {
		steps = append(steps, "BrandBrain could not be reached to resolve the subject; disable shorted's side by subject: call again with subject from housing_crawl_rigs")
	}
	switch shorted {
	case ShortedEnabled:
		steps = append(steps, "The rig's pushes are admitted within about a minute: the ingest caches the allowlist for 60 seconds.")
	case ShortedDisabled:
		steps = append(steps, "The rig's pushes are refused within about a minute: the ingest caches the allowlist for 60 seconds.")
	case ShortedFailed:
		if !subjectUnknown {
			steps = append(steps, "The shorted allowlist write did not complete. Run this tool again: it is idempotent.")
		}
	}
	switch bbState {
	case BrandBrainUnknown:
		steps = append(steps, "BrandBrain did not confirm the change. Check the grant with housing_crawl_rigs, then run this tool again. Nothing was retried automatically.")
	case BrandBrainFailed:
		steps = append(steps, "BrandBrain refused the change, so its grant was not changed.")
	case BrandBrainNotAttempted:
		steps = append(steps, "BrandBrain was not called, so its grant is unchanged. Once BrandBrain is reachable, revoke the grant with housing_crawl_authorize (rig_id, enabled=false).")
	}
	if bbState == BrandBrainGranted || bbState == BrandBrainUnchanged || bbState == BrandBrainRevoked {
		switch mintReason {
		case "ok":
			if enabling {
				steps = append(steps, "The rig can mint workload tokens.")
			}
		case "user_session":
			steps = append(steps, "The rig signs in with a user session; it needs an operator-issued rig token with workload:mint before it can mint.")
		case "no_rig_token":
			steps = append(steps, "No rig token is issued to this rig; issue one with workload:mint in BrandBrain.")
		case "not_active":
			steps = append(steps, "The rig is not active in BrandBrain; activate it before it can mint.")
		case "no_grant":
			steps = append(steps, "The housing_crawl_v1 grant is not set for this rig.")
		case "version_too_old":
			steps = append(steps, "The rig runs a version too old to mint; update the rig.")
		}
	}
	return steps
}

// --- refusals -----------------------------------------------------------------

var (
	errCrawlRigID                 = errors.New("rig_id must be 1 to 100 letters, digits, dots, underscores or hyphens; nothing was sent")
	errCrawlOneTarget             = errors.New("give exactly one of rig_id or subject; nothing was sent or written")
	errCrawlSubjectEnable         = errors.New("subject is only valid with enabled=false: enabling a rig needs rig_id, so BrandBrain supplies the subject; nothing was written")
	errCrawlSubject               = errors.New("subject must be rig: followed by 1 to 100 letters, digits, dots, underscores or hyphens, starting with a letter or digit, as housing_crawl_rigs lists it; nothing was written")
	errCrawlConfirm               = errors.New("enabling a rig needs confirm=true; nothing was sent or written. Disabling does not need it")
	errCrawlNote                  = fmt.Errorf("note must be at most %d characters; nothing was written", crawlNoteMax)
	errCrawlNotConfigured         = errors.New("BRANDBRAIN_HOUSING_GRANT_TOKEN is not configured on this deployment, so BrandBrain's grant cannot be read or changed; nothing was written")
	errCrawlStoreUnavailable      = errors.New("the housing crawl allowlist is not configured on this deployment; nothing was written")
	errCrawlStoreRead             = errors.New("the housing crawl allowlist could not be read")
	errCrawlRigNotFound           = errors.New("rig_not_found: BrandBrain has no such rig; nothing was written")
	errCrawlBrandBrainRejected    = errors.New("BrandBrain rejected the grant token for this route; nothing was written. Check BRANDBRAIN_HOUSING_GRANT_TOKEN")
	errCrawlBrandBrainUnavailable = errors.New("BrandBrain could not be read, so the rig's subject is unknown; nothing was written. Try again later")
	errCrawlNoSubject             = errors.New("BrandBrain returned no usable workload_subject for this rig; nothing was written")
)

// crawlToolError turns a refusal into a tool-level error the model can read. The
// text is fixed per refusal; it never carries a token, a response body or a URL.
func crawlToolError(err error) *sdk.CallToolResult {
	res := &sdk.CallToolResult{}
	res.SetError(err)
	return res
}

// crawlAdminTools lists the two crawl tools for the admin registry.
func crawlAdminTools() []AdminTool {
	return []AdminTool{crawlRigsTool(), crawlAuthorizeTool()}
}
