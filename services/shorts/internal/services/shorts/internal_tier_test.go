package shorts

import "testing"

func TestInternalTierForIsEmptyByDefault(t *testing.T) {
	// A deployment that configures nothing must grant nothing — this change
	// cannot widen access merely by being merged.
	t.Setenv(InternalTierUsersEnv, "")
	if _, ok := InternalTierFor("anyone"); ok {
		t.Fatal("granted a tier with no allowlist configured")
	}
}

func TestInternalTierForGrantsListedUser(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "user-a, user-b ,user-c")
	for _, id := range []string{"user-a", "user-b", "user-c"} {
		tier, ok := InternalTierFor(id)
		if !ok {
			t.Errorf("%s not granted", id)
		}
		if tier != defaultInternalTier {
			t.Errorf("%s got tier %q, want %q", id, tier, defaultInternalTier)
		}
	}
	if _, ok := InternalTierFor("user-d"); ok {
		t.Error("granted a tier to an unlisted user")
	}
}

func TestInternalTierIsConfigurable(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "user-a")
	t.Setenv(InternalTierEnv, "pro")
	if tier, _ := InternalTierFor("user-a"); tier != "pro" {
		t.Errorf("tier = %q, want pro", tier)
	}
}

func TestInternalTierForIgnoresEmptyUserID(t *testing.T) {
	// An anonymous caller has no user id; an allowlist entry that was blank
	// must not match it.
	t.Setenv(InternalTierUsersEnv, " , ,")
	if _, ok := InternalTierFor(""); ok {
		t.Fatal("granted a tier to an empty user id")
	}
}
