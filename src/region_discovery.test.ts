const mockPost = jest.fn();
jest.mock("../roborockLib/lib/httpClient", () => ({
  createHttpClient: () => ({
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

const roborockAuth = require("../roborockLib/lib/roborockAuth");

const post = mockPost;

describe("roborockAuth.discoverAccountRegion", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("returns the normalized endpoint and country from the first host", async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 200,
        data: {
          url: "https://euiot.roborock.com",
          country: "GB",
          countrycode: 44,
        },
      },
    });

    const result = await roborockAuth.discoverAccountRegion("user@example.com");

    expect(result).toEqual({
      baseURL: "euiot.roborock.com",
      country: "GB",
      countryCode: "44",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(
      "https://usiot.roborock.com/api/v1/getUrlByEmail"
    );
    expect(post.mock.calls[0][2].params).toEqual({
      email: "user@example.com",
      needtwostepauth: "false",
    });
  });

  it("falls through an unreachable host to the next one", async () => {
    post.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({
      data: {
        code: 200,
        data: {
          url: "https://cniot.roborock.com",
          country: "CN",
          countrycode: "86",
        },
      },
    });

    const result = await roborockAuth.discoverAccountRegion("user@example.com");

    expect(result?.baseURL).toBe("cniot.roborock.com");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("returns null when every host fails", async () => {
    post.mockRejectedValue(new Error("offline"));

    await expect(
      roborockAuth.discoverAccountRegion("user@example.com")
    ).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("rejects an endpoint outside roborock.com without probing further", async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 200,
        data: {
          url: "https://evil.example.com",
          country: "US",
          countrycode: "1",
        },
      },
    });

    await expect(
      roborockAuth.discoverAccountRegion("user@example.com")
    ).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects a suffix-spoofed hostname", async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 200,
        data: {
          url: "https://evilroborock.com",
          country: "US",
          countrycode: "1",
        },
      },
    });

    await expect(
      roborockAuth.discoverAccountRegion("user@example.com")
    ).resolves.toBeNull();
  });

  it("skips hosts answering a non-200 code", async () => {
    post.mockResolvedValue({ data: { code: 2003, msg: "invalid email" } });

    await expect(
      roborockAuth.discoverAccountRegion("not-an-email")
    ).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(4);
  });
});
