import Page from "../page";

const mockGetThread = jest.fn();
const mockGetComments = jest.fn();
jest.mock("~/@/lib/community/community-activity-cache", () => ({
  getCachedCommunityThread: (...args: unknown[]) => mockGetThread(...args),
  getCachedCommunityComments: (...args: unknown[]) => mockGetComments(...args),
}));
jest.mock("~/@/components/company/community/community-thread-detail", () => ({
  CommunityThreadDetail: () => null,
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

it("projects thread and saved-reply authors before serializing client component props", async () => {
  const privateAuthor = {
    userId: "private-firebase-uid",
    displayName: "private.address@example.test",
    handle: "private-provider-handle",
    avatarUrl: "https://provider.example/private-avatar",
    trustScore: 999,
  };
  mockGetThread.mockResolvedValue({
    id: "thread-1",
    stockCode: "CBA",
    title: "Question",
    author: privateAuthor,
  });
  const privateCommentAuthor = {
    ...privateAuthor,
    userId: "private-comment-firebase-uid",
    displayName: "comment.address@example.test",
    avatarUrl: "https://provider.example/private-comment-avatar",
  };
  const storedComment = {
    id: "comment-1",
    threadId: "thread-1",
    stockCode: "CBA",
    body: "A saved reply with evidence.",
    author: privateCommentAuthor,
  };
  mockGetComments.mockResolvedValue([storedComment]);
  const element = await Page({
    params: Promise.resolve({ stockCode: "CBA", threadId: "thread-1" }),
  });
  expect(element.props.thread.author).toEqual({
    displayName: "Community member",
  });
  expect(mockGetComments).toHaveBeenCalledWith("CBA", "thread-1");
  expect(element.props.comments).toHaveLength(1);
  expect(element.props.comments[0]).toMatchObject({
    id: "comment-1",
    threadId: "thread-1",
    body: "A saved reply with evidence.",
    author: { displayName: "Community member" },
  });
  expect(element.props.comments[0].author).toEqual({
    displayName: "Community member",
  });
  const payload = JSON.stringify(element.props);
  for (const author of [privateAuthor, privateCommentAuthor]) {
    for (const privateValue of [
      author.userId,
      author.displayName,
      author.avatarUrl,
      author.handle,
    ]) {
      expect(payload).not.toContain(privateValue);
    }
  }
  expect(privateAuthor.displayName).toBe("private.address@example.test");
  expect(storedComment.author).toBe(privateCommentAuthor);
  expect(privateCommentAuthor.displayName).toBe("comment.address@example.test");
});
