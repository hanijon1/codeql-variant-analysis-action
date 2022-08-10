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
import {
  getSignedUrlForRepoArtifact,
  setVariantAnalysisFailed,
  setVariantAnalysisRepoInProgress,
  setVariantAnalysisRepoSucceeded,
} from "./api-client";
import { uploadArtifactToAzure } from "./azure-storage-client";

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
  const variantAnalysisId = parseInt(getInput("variant_analysis_id"));
  if (variantAnalysisId) {
    // do something new
  }

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
      if (variantAnalysisId) {
        await setVariantAnalysisFailed(
          variantAnalysisId,
          repo.id,
          error.message
        );
      }
    }
    return;
  }

  for (const repo of repos) {
    // Create a new directory to contain all files created during analysis of this repo.
    const workDir = fs.mkdtempSync(path.join(curDir, repo.id.toString()));
    // Change into the new directory to further ensure that all created files go in there.
    chdir(workDir);

    try {
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

      if (variantAnalysisId) {
        // 1.5 Mark variant analysis for repo task as in progress
        await setVariantAnalysisRepoInProgress(variantAnalysisId, repo.id);
      }

      // 2. Run the query
      console.log("Running query");
      const queryRunResult = await runQuery(codeql, dbZip, repo.nwo, queryPack);

      if (variantAnalysisId) {
        // 2.5 Get signed URL for artifact upload
        const signedUrl = await getSignedUrlForRepoArtifact(
          variantAnalysisId,
          repo.id
        );

        // Create Azure client for uploading to Azure Blob Storage
        const fileToUpload =
          queryRunResult.sarifFilePath || queryRunResult.bqrsFilePath;
        await uploadArtifactToAzure(signedUrl, fileToUpload);

        // 3. Mark variant analysis for repo task as succeeded
        await setVariantAnalysisRepoSucceeded(
          variantAnalysisId,
          repo.id,
          queryRunResult.sourceLocationPrefix,
          queryRunResult.resultCount,
          queryRunResult.databaseSHA || "HEAD"
        );
      }

      // 3. Upload the results as an artifact
      const filesToUpload = [
        queryRunResult.bqrsFilePath,
        queryRunResult.metadataFilePath,
      ];
      if (queryRunResult.sarifFilePath) {
        filesToUpload.push(queryRunResult.sarifFilePath);
      }
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
      if (variantAnalysisId) {
        await setVariantAnalysisFailed(
          variantAnalysisId,
          repo.id,
          error.message
        );
      }
    }

    // We can now delete the work dir. All required files have already been uploaded.
    chdir(curDir);
    fs.rmdirSync(workDir, { recursive: true });
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

void run();
