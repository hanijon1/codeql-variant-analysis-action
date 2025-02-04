import fs from "fs";
import path from "path";

import { exec } from "@actions/exec";
import { rmRF } from "@actions/io";
import anyTest, { TestInterface } from "ava";

import {
  runQuery,
  getBqrsInfo,
  getDatabaseMetadata,
  BQRSInfo,
  getRemoteQueryPackDefaultQuery,
  injectVersionControlInfo,
  getSarifResultCount,
  Sarif,
} from "./codeql";

const test = anyTest as TestInterface<{ db: string; tmpDir: string }>;

test.before(async (t) => {
  const tmpDir = path.resolve(fs.mkdtempSync("tmp"));
  t.context.tmpDir = tmpDir;

  const projectDir = path.join(tmpDir, "project");
  const dbDir = path.join(tmpDir, "db");
  fs.mkdirSync(projectDir);
  const testFile = path.join(projectDir, "test.js");
  fs.writeFileSync(testFile, "const x = 1;");

  await exec("codeql", [
    "database",
    "create",
    "--language=javascript",
    `--source-root=${projectDir}`,
    dbDir,
  ]);

  const dbZip = path.join(tmpDir, "database.zip");
  await exec("codeql", ["database", "bundle", `--output=${dbZip}`, dbDir]);
  t.context.db = dbZip;
});

test.after(async (t) => {
  if (t.context?.tmpDir !== undefined) {
    await rmRF(t.context.tmpDir);
  }
});

test("running a query in a pack", async (t) => {
  const queryPack = path.resolve("testdata/test_pack");
  const tmpDir = fs.mkdtempSync("tmp");
  const cwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await runQuery("codeql", t.context.db, "a/b", queryPack);

    t.true(fs.existsSync(path.join("results", "results.bqrs")));

    const bqrsInfo: BQRSInfo = await getBqrsInfo(
      "codeql",
      path.join("results", "results.bqrs")
    );
    t.is(1, bqrsInfo.resultSets.length);
    t.is("#select", bqrsInfo.resultSets[0].name);
    t.true(bqrsInfo.compatibleQueryKinds.includes("Table"));
  } finally {
    process.chdir(cwd);
    await rmRF(tmpDir);
  }
});

test("getting the commit SHA and CLI version from a database", async (t) => {
  const tmpDir = fs.mkdtempSync("tmp");
  try {
    fs.writeFileSync(
      path.join(tmpDir, "codeql-database.yml"),
      `---
sourceLocationPrefix: "hello-world"
baselineLinesOfCode: 1
unicodeNewlines: true
columnKind: "utf16"
primaryLanguage: "javascript"
creationMetadata:
  sha: "ccf1e13626d97b009b4da78f719f028d9f7cdf80"
  cliVersion: "2.7.2"
  creationTime: "2021-11-08T12:58:40.345998Z"
`
    );
    t.is(
      getDatabaseMetadata(tmpDir).creationMetadata?.sha,
      "ccf1e13626d97b009b4da78f719f028d9f7cdf80"
    );
    t.is(getDatabaseMetadata(tmpDir).creationMetadata?.cliVersion, "2.7.2");
  } finally {
    await rmRF(tmpDir);
  }
});

test("getting the commit SHA when codeql-database.yml exists, but does not contain SHA", async (t) => {
  const tmpDir = fs.mkdtempSync("tmp");
  try {
    fs.writeFileSync(
      path.join(tmpDir, "codeql-database.yml"),
      `---
sourceLocationPrefix: "hello-world"
baselineLinesOfCode: 17442
unicodeNewlines: true
columnKind: "utf16"
primaryLanguage: "javascript"
`
    );
    t.is(getDatabaseMetadata(tmpDir).creationMetadata?.sha, undefined);
  } finally {
    await rmRF(tmpDir);
  }
});

test("getting the commit SHA when codeql-database.yml exists, but is invalid", async (t) => {
  const tmpDir = fs.mkdtempSync("tmp");
  try {
    fs.writeFileSync(
      path.join(tmpDir, "codeql-database.yml"),
      `    foo:"
bar
`
    );
    t.is(getDatabaseMetadata(tmpDir).creationMetadata?.sha, undefined);
  } finally {
    await rmRF(tmpDir);
  }
});

test("getting the commit SHA when the codeql-database.yml does not exist", async (t) => {
  const tmpDir = fs.mkdtempSync("tmp");
  try {
    t.is(getDatabaseMetadata(tmpDir).creationMetadata?.sha, undefined);
  } finally {
    await rmRF(tmpDir);
  }
});

test("getting the default query from a pack", async (t) => {
  t.is(
    await getRemoteQueryPackDefaultQuery("codeql", "testdata/test_pack"),
    path.resolve("testdata/test_pack/x/query.ql")
  );
});

test("populating the SARIF versionControlProvenance property", (t) => {
  const sarif: Sarif = {
    runs: [
      {
        results: [],
      },
    ],
  };
  const nwo = "a/b";
  const sha = "testsha123";

  injectVersionControlInfo(sarif, nwo, sha);
  const expected = {
    repositoryUri: `https://github.com/${nwo}`,
    revisionId: sha,
  };

  t.deepEqual(sarif.runs[0].versionControlProvenance?.[0], expected);
});

test("counting the number of results in a SARIF file)", (t) => {
  const sarif: Sarif = {
    runs: [
      {
        results: [
          {
            ruleId: "test-rule1",
          },
          {
            ruleId: "test-rule2",
          },
          {
            ruleId: "test-rule3",
          },
        ],
      },
    ],
  };

  const resultCount = getSarifResultCount(sarif);
  t.is(resultCount, 3);
});
