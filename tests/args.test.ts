import { expect, test } from "bun:test";
import { completeArgs, parseArgs } from "../args.ts";

test("no arguments browses", () => {
	expect(parseArgs("")).toEqual({ kind: "browse" });
	expect(parseArgs("   ")).toEqual({ kind: "browse" });
});

test("find and grep take the rest of the line as the query, spaces included", () => {
	expect(parseArgs("find")).toEqual({ kind: "find", query: "" });
	expect(parseArgs("find browser")).toEqual({ kind: "find", query: "browser" });
	expect(parseArgs("grep  TODO later ")).toEqual({ kind: "grep", query: "TODO later" });
});

test("changes defaults to the last turn; session widens it", () => {
	expect(parseArgs("changes")).toEqual({ kind: "changes", scope: "last" });
	expect(parseArgs("changes session")).toEqual({ kind: "changes", scope: "session" });
	expect(parseArgs("changes yesterday").kind).toBe("error");
});

test("anything else is a path, and ./find reaches a folder named like a subcommand", () => {
	expect(parseArgs("src/lib")).toEqual({ kind: "path", path: "src/lib" });
	expect(parseArgs("./find")).toEqual({ kind: "path", path: "./find" });
	expect(parseArgs("my folder/a.ts")).toEqual({ kind: "path", path: "my folder/a.ts" });
	expect(parseArgs("findings.md")).toEqual({ kind: "path", path: "findings.md" });
});

test("completions offer subcommands for the first word only", () => {
	expect(completeArgs("")?.map(c => c.label)).toEqual(["find", "grep", "changes"]);
	expect(completeArgs("g")?.map(c => c.label)).toEqual(["grep"]);
	expect(completeArgs("x")).toBeNull();
	expect(completeArgs("find foo")).toBeNull();
});
