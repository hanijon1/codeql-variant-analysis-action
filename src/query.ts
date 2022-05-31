import fs from "fs";
import path from "path";
import { chdir, cwd } from "process";

import {
  ArtifactClient,
  create as createArtifactClient,
} from "@actions/artifact";
import { getInput, setSecret, setFailed } from "@actions/core";
import { extractTar } from "@actions/tool-cache";

import { downloadDatabase, runQuery } from "./codeql";
import { download } from "./download";
import { writeQueryRunMetadataToFile } from "./query-run-metadata";

interface Repo {
  id: number;
  nwo: string;
  downloadUrl?: string;

  // pat is deprecated and only used during integration tests
  pat?: string;
}

async function run(): Promise<void> {
  const artifactClient = createArtifactClient();
  const queryPackUrl = getInput("query_pack_url", { required: true });
  const language = getInput("language", { required: true });
  const repos: Repo[] = JSON.parse(
    getInput("repositories", { required: true })
  );
  const codeql = getInput("codeql", { required: true });

  for (const repo of repos) {
    if (repo.downloadUrl) {
      setSecret(repo.downloadUrl);
    }
    if (repo.pat) {
      setSecret(repo.pat);
    }
  }

  const curDir = cwd();

  let queryPack: string;
  try {
    // Download and extract the query pack.
    console.log("Getting query pack");
    const queryPackArchive = await download(queryPackUrl, "query_pack.tar.gz");
    queryPack = await extractTar(queryPackArchive);
  } catch (error: any) {
    // Consider all repos to have failed
    setFailed(error.message);
    for (const repo of repos) {
      await uploadError(error, repo, artifactClient);
    }
    return;
  }

  for (const repo of repos) {
    try {
      await handleCancellations(repo, artifactClient);

      const workDir = fs.mkdtempSync(path.join(curDir, repo.id.toString()));
      chdir(workDir);

      let dbZip: string;
      if (repo.downloadUrl) {
        // 1a. Use the provided signed URL to download the database
        console.log("Getting database");
        dbZip = await download(repo.downloadUrl, `${repo.id}.zip`);
      } else {
        // 1b. Use the GitHub API to download the database using token
        console.log("Getting database");
        dbZip = await downloadDatabase(repo.id, repo.nwo, language, repo.pat);
      }

      // 2. Run the query
      console.log("Running query");
      const filesToUpload = await runQuery(codeql, dbZip, repo.nwo, queryPack);

      // 3. Upload the results as an artifact
      console.log("Uploading artifact");
      await artifactClient.uploadArtifact(
        repo.id.toString(), // name
        filesToUpload, // files
        "results", // rootdirectory
        { continueOnError: false }
      );
    } catch (error: any) {
      setFailed(error.message);
      await uploadError(error, repo, artifactClient);
    }
  }
}

// Write error messages to a file and upload as an artifact,
// so that the combine-results job "knows" about the failures.
async function uploadError(
  error: any,
  repo: Repo,
  artifactClient: ArtifactClient
) {
  fs.mkdirSync("errors");
  const errorFilePath = path.join("errors", "error.txt");
  fs.appendFileSync(errorFilePath, error.message);

  const metadataFilePath = path.join("errors", "metadata.json");

  writeQueryRunMetadataToFile(metadataFilePath, repo.nwo);

  await artifactClient.uploadArtifact(
    `${repo.id.toString()}-error`, // name
    [errorFilePath, metadataFilePath], // files
    "errors", // rootdirectory
    { continueOnError: false }
  );
}

/**
 * Attempts to upload an error artifact if a job is cancelled.
 * Note: All jobs will be force-cancelled after 5 mins, so we may not get through all repositories.
 *
 * Information about workflow cancellations here:
 * https://docs.github.com/en/actions/managing-workflow-runs/canceling-a-workflow#steps-github-takes-to-cancel-a-workflow-run
 */
async function handleCancellations(repo: Repo, artifactClient: ArtifactClient) {
  let isCancelled = false;
  process.on("SIGINT", () => {
    isCancelled = true;
    console.log(
      `SIGINT received, uploading error artifact for repo ${repo.nwo}`
    );
  });
  process.on("SIGTERM", () => {
    isCancelled = true;
    console.log(
      `SIGTERM received, uploading error artifact for repo ${repo.nwo}`
    );
  });
  if (isCancelled) {
    await uploadError("Job cancelled", repo, artifactClient);
  }
}

void run();
