import type { ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSubscription } from "../use-subscription";
import { getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "user-1", email: "buyer@example.test" } },
    status: "authenticated",
  }),
}));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

const getMock = getSubscriptionStatus as jest.Mock;

const PREMIUM = {
  status: "active",
  tier: "premium",
  hasActiveSubscription: true,
  isPremium: true,
  canMintTokens: true,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  features: [],
  requestsPerDay: 10000,
};

const FAILED = {
  status: "inactive",
  tier: "free",
  hasActiveSubscription: false,
  isPremium: false,
  canMintTokens: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  features: [],
  requestsPerDay: 100,
  lookupFailed: true,
};

function setup() {
  // Retries are off so a failure stays a failure for the assertions.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSubscription(), { wrapper });
  return { queryClient, ...hook };
}

describe("useSubscription", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not cache a failed lookup as the answer", async () => {
    getMock.mockResolvedValue(FAILED);

    const { result, queryClient } = setup();

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isPremium).toBe(false);
    expect(result.current.subscription).toBeNull();
    expect(queryClient.getQueryData(["subscription", "user-1"])).toBeUndefined();
  });

  it("asks again after a failure and adopts the next real answer", async () => {
    getMock.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(PREMIUM);

    const { result, queryClient } = setup();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isPremium).toBe(false);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["subscription"] });
    });

    await waitFor(() => expect(result.current.isPremium).toBe(true));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected lookup the same way, with no cached free answer", async () => {
    getMock.mockRejectedValueOnce(new Error("transport"));

    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isPremium).toBe(false);
    expect(queryClient.getQueryData(["subscription", "user-1"])).toBeUndefined();
  });

  it("caches a genuine answer", async () => {
    getMock.mockResolvedValue(PREMIUM);

    const { result } = setup();
    await waitFor(() => expect(result.current.isPremium).toBe(true));
    expect(result.current.tier).toBe("premium");
  });
});
