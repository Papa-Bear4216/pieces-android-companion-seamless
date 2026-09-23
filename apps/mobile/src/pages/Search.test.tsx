import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/semanticSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/semanticSearch")>();
  return { ...actual, semanticSearch: vi.fn() };
});
vi.mock("../lib/usage", () => ({ recordEvent: vi.fn() }));

import { semanticSearch } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";
import Search from "./Search";

beforeEach(() => vi.clearAllMocks());

async function type(value: string) {
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
}

describe("Search page", () => {
  test("renders hits with source badges and records a telemetry event", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [
        { text: "bought a lamp", score: 0.8, timestamp: "2026-02-01T00:00:00Z", source: "local", app_label: "Amazon" },
        { text: "wrote the report", score: 0.7, timestamp: "2026-02-02T00:00:00Z", source: "server" },
      ],
      serverSkipped: false,
      mode: "relevant",
    });
    render(<Search />);
    await type("stuff");
    await waitFor(() => expect(screen.getByText("bought a lamp")).toBeTruthy());
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("On this device")).toBeTruthy();
    expect(within(cards[1]).getByText("From home PC")).toBeTruthy();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "search", screen: "search", query: "stuff", resultCount: 2, mode: "relevant" }),
    );
  });

  test("renders a server hit's human-readable timestamp literally and formats a local ISO timestamp", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [
        { text: "wrote the report", score: 0.7, timestamp: "3 days ago", source: "server" },
        { text: "bought a lamp", score: 0.8, timestamp: "2026-02-01T00:00:00Z", source: "local", app_label: "Amazon" },
      ],
      serverSkipped: false,
      mode: "relevant",
    });
    render(<Search />);
    await type("stuff");
    await waitFor(() => expect(screen.getByText("wrote the report")).toBeTruthy());
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("3 days ago")).toBeTruthy();
    expect(within(cards[0]).queryByText(/invalid date/i)).toBeNull();
    const localMeta = within(cards[1]).getByText(new Date("2026-02-01T00:00:00Z").toLocaleString());
    expect(localMeta).toBeTruthy();
  });

  test("shows the offline banner when serverSkipped", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: true, mode: "relevant" });
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByText(/home pc offline/i)).toBeTruthy());
  });

  test("shows the empty state when there are no hits", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: false, mode: "relevant" });
    render(<Search />);
    await type("nothing");
    await waitFor(() => expect(screen.getByText(/nothing matched/i)).toBeTruthy());
  });

  test("shows the fallback note when mode is text-fallback", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [{ text: "t", score: 1, timestamp: "2026-02-01T00:00:00Z", source: "local" }],
      serverSkipped: false,
      mode: "text-fallback",
    });
    render(<Search />);
    await type("t");
    await waitFor(() => expect(screen.getByText(/meaning-based search isn't available/i)).toBeTruthy());
  });

  test("shows an error + retry when semanticSearch throws", async () => {
    vi.mocked(semanticSearch).mockRejectedValue(new Error("boom"));
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
  });

  test("debounces rapid keystrokes so only the final query executes and logs", async () => {
    vi.useFakeTimers();
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: false, mode: "relevant" });

    render(<Search />);
    const input = screen.getByPlaceholderText(/search/i);

    // Rapid keystrokes: M -> Mo -> Mov -> Movie without pressing enter
    fireEvent.change(input, { target: { value: "M" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "Mo" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "Mov" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "Movie" } });

    // No search call should have happened yet
    expect(semanticSearch).not.toHaveBeenCalled();

    // Advance beyond 400ms debounce
    await vi.advanceTimersByTimeAsync(450);

    expect(semanticSearch).toHaveBeenCalledTimes(1);
    expect(semanticSearch).toHaveBeenCalledWith("Movie", expect.anything());
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ query: "Movie" }));

    vi.useRealTimers();
  });

  test("discards slow in-flight response if superseded by a newer query", async () => {
    let resolveFirst: (val: any) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    vi.mocked(semanticSearch)
      .mockImplementationOnce(() => firstPromise as any)
      .mockResolvedValueOnce({
        hits: [{ text: "cats result", score: 0.9, timestamp: "2026-02-01T00:00:00Z", source: "local" }],
        serverSkipped: false,
        mode: "relevant",
      });

    render(<Search />);
    const input = screen.getByPlaceholderText(/search/i);

    // Trigger first search
    fireEvent.change(input, { target: { value: "dog" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    // Trigger second search immediately before first finishes
    fireEvent.change(input, { target: { value: "cats" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => expect(screen.getByText("cats result")).toBeTruthy());

    // Now first search finishes with old results
    resolveFirst!({
      hits: [{ text: "dog result", score: 0.9, timestamp: "2026-02-01T00:00:00Z", source: "local" }],
      serverSkipped: false,
      mode: "relevant",
    });

    // Verify screen still shows "cats result" and not clobbered by "dog result"
    expect(screen.queryByText("dog result")).toBeNull();
    expect(screen.getByText("cats result")).toBeTruthy();
    // Only the winning query was recorded
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ query: "cats" }));
    expect(recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ query: "dog" }));
  });
});
