import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFileSync } from "fs";
import minimatch from "minimatch";
import { parseDiff } from "diff-parser";

import { analyzeCode } from "./ai";
import { createReviewComment } from "./review";

interface PRDetails {
    owner: string;
    repo: string;
    pull_number: number;
    title: string;
    description: string;
}

const token = process.env.GITHUB_TOKEN ?? "";
const octokit = github.getOctokit(token);

async function getPRDetails(): Promise<PRDetails> {
    const { owner, repo } = github.context.repo;
    const pull_number = github.context.payload.pull_request?.number;

    if (!pull_number) {
        throw new Error("No pull request number found in context");
    }

    const { data } = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
    });

    return {
        owner,
        repo,
        pull_number,
        title: data.title,
        description: data.body ?? "",
    };
}

async function getDiff(owner: string, repo: string, pull_number: number) {
    const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
    });
    return String(response.data);
}

async function main() {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const eventData = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );

    let diff: string | null = null;

    if (eventName === "pull_request") {
        // PR 事件逻辑
        const prDetails = await getPRDetails();

        if (eventData.action === "opened") {
            diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
        } else if (eventData.action === "synchronize") {
            const newBaseSha = eventData.before;
            const newHeadSha = eventData.after;

            const response = await octokit.repos.compareCommits({
                headers: { accept: "application/vnd.github.v3.diff" },
                owner: prDetails.owner,
                repo: prDetails.repo,
                base: newBaseSha,
                head: newHeadSha,
            });

            diff = String(response.data);
        } else {
            console.log("Unsupported pull_request action:", eventData.action);
            return;
        }

        if (!diff) {
            console.log("No diff found in PR");
            return;
        }

        const parsedDiff = parseDiff(diff);
        const excludePatterns = core
            .getInput("exclude")
            .split(",")
            .map((s) => s.trim());
        const filteredDiff = parsedDiff.filter(
            (file) => !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern))
        );

        const comments = await analyzeCode(filteredDiff, prDetails);
        if (comments.length > 0) {
            await createReviewComment(
                prDetails.owner,
                prDetails.repo,
                prDetails.pull_number,
                comments
            );
        }
    } else if (eventName === "push") {
        // push 事件逻辑
        const owner =
            eventData.repository.owner.name || eventData.repository.owner.login;
        const repo = eventData.repository.name;
        const base = eventData.before;
        const head = eventData.after;

        const response = await octokit.repos.compareCommits({
            headers: { accept: "application/vnd.github.v3.diff" },
            owner,
            repo,
            base,
            head,
        });

        diff = String(response.data);

        if (!diff) {
            console.log("No diff found in push");
            return;
        }

        const parsedDiff = parseDiff(diff);
        const excludePatterns = core
            .getInput("exclude")
            .split(",")
            .map((s) => s.trim());
        const filteredDiff = parsedDiff.filter(
            (file) => !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern))
        );

        const fakePR: PRDetails = {
            owner,
            repo,
            pull_number: 0,
            title: `Push analysis: ${head}`,
            description: "",
        };

        const comments = await analyzeCode(filteredDiff, fakePR);
        console.log("Push analysis result:", comments);
        // 👉 这里目前只打印结果，你也可以改成创建 Issue / PR 评论 / 上传 artifact
    } else {
        console.log("Unsupported event type:", eventName);
    }
}

main().catch((error) => {
    core.setFailed(error.message);
});
