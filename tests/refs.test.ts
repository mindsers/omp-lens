import { expect, test } from "bun:test";
import { reference } from "../refs.ts";

const cwd = "/work/repo";

test("files inside the working directory are mentioned by relative path", () => {
	expect(reference({ path: "/work/repo/src/app.ts" }, cwd)).toBe("@src/app.ts");
});

test("files outside the working directory keep their absolute path", () => {
	expect(reference({ path: "/other/place/x.ts" }, cwd)).toBe("@/other/place/x.ts");
	expect(reference({ path: "/work/repo-sibling/x.ts" }, cwd)).toBe("@/work/repo-sibling/x.ts");
});

test("a single line and a line range", () => {
	expect(reference({ path: "/work/repo/a.ts", from: 12 }, cwd)).toBe("@a.ts#L12");
	expect(reference({ path: "/work/repo/a.ts", from: 12, to: 12 }, cwd)).toBe("@a.ts#L12");
	expect(reference({ path: "/work/repo/a.ts", from: 8, to: 20 }, cwd)).toBe("@a.ts#L8-20");
});
