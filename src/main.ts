import * as core from "@actions/core";
import * as github from "@actions/github";
import {readFileSync} from "fs";
import {parseDiff} from "diff-parser";
import minimatch from "minimatch";
import nodemailer from "nodemailer";

import {analyzeCode} from "./ai";
import {createReviewComment} from "./review";

interface ContextDetails {
    owner: string;
    repo: string;
    commitSha?: string;
    pull_number?: number;
    title: string;
    description: string;
}

async function main() {
    try {
        const token = core.getInput("GITHUB_TOKEN");
        const octokit = github.getOctokit(token);

        const eventName = process.env.GITHUB_EVENT_NAME;
        const eventData = JSON.parse(
            readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
        );

        let diff: string | null = null;
        let contextDetails: ContextDetails;

        if (eventName === "pull_request") {
            // PR 事件
            const {owner, repo} = github.context.repo;
            const pull_number = github.context.payload.pull_request?.number;
            if (!pull_number) throw new Error("No pull request number found in context");

            const {data: prData} = await octokit.pulls.get({
                owner,
                repo,
                pull_number,
            });

            contextDetails = {
                owner,
                repo,
                pull_number,
                title: prData.title,
                description: prData.body ?? "",
            };

            // 获取 diff
            if (eventData.action === "opened") {
                const response = await octokit.pulls.get({
                    owner,
                    repo,
                    pull_number,
                    mediaType: {format: "diff"},
                });
                diff = String(response.data);
            } else if (eventData.action === "synchronize") {
                const response = await octokit.repos.compareCommits({
                    headers: {accept: "application/vnd.github.v3.diff"},
                    owner,
                    repo,
                    base: eventData.before,
                    head: eventData.after,
                });
                diff = String(response.data);
            } else {
                core.info(`Unsupported PR action: ${eventData.action}`);
                return;
            }

            if (!diff) {
                core.info("No diff found in PR");
                return;
            }

            // 解析 diff
            const parsedDiff = parseDiff(diff);
            const excludePatterns = core.getInput("exclude").split(",").map(s => s.trim());
            const filteredDiff = parsedDiff.filter(
                file => !excludePatterns.some(pattern => minimatch(file.to ?? "", pattern))
            );

            // 调用 AI
            const comments = await analyzeCode(filteredDiff, contextDetails);

            if (comments.length > 0) {
                // 评论到 PR
                await createReviewComment(
                    contextDetails.owner,
                    contextDetails.repo,
                    contextDetails.pull_number!,
                    comments
                );
            }

        } else if (eventName === "push") {
            // Push 事件
            const owner = eventData.repository.owner.name || eventData.repository.owner.login;
            const repo = eventData.repository.name;
            const base = eventData.before;
            const head = eventData.after;

            const response = await octokit.repos.compareCommits({
                headers: {accept: "application/vnd.github.v3.diff"},
                owner,
                repo,
                base,
                head,
            });

            diff = String(response.data);

            if (!diff) {
                core.info("No diff found in push");
                return;
            }

            const parsedDiff = parseDiff(diff);
            const excludePatterns = core.getInput("exclude").split(",").map(s => s.trim());
            const filteredDiff = parsedDiff.filter(
                file => !excludePatterns.some(pattern => minimatch(file.to ?? "", pattern))
            );

            contextDetails = {
                owner,
                repo,
                commitSha: head,
                title: `Push analysis: ${head}`,
                description: eventData.head_commit?.message ?? "",
            };


            // Push 事件调用 AI 分析后的处理
            const reviewComments = await analyzeCode(filteredDiff, contextDetails);

            core.info("Push AI review result:");
            core.info(JSON.stringify(reviewComments, null, 2));

           // 发送邮件（可选）
            const mailHost = core.getInput("MAIL_HOST");
            const mailPort = core.getInput("MAIL_PORT");
            const mailSecure = core.getInput("MAIL_SECURE");
            const mailUser = core.getInput("MAIL_USER");
            const mailPass = core.getInput("MAIL_PASS");
            const mailFrom = core.getInput("MAIL_FROM");
            const mailTo = core.getInput("MAIL_TO");

            if (mailHost && mailPort && mailUser && mailPass && mailFrom && mailTo) {
                const transporter = nodemailer.createTransport({
                    host: mailHost,
                    port: parseInt(mailPort),
                    secure: mailSecure === "true",
                    auth: {
                        user: mailUser,
                        pass: mailPass,
                    },
                });

                await transporter.sendMail({
                    from: mailFrom,
                    to: mailTo,
                    subject: `AI Review Result: ${contextDetails.commitSha}`,
                    text: JSON.stringify(reviewComments, null, 2),
                });

                core.info("Review email sent successfully.");
            } else {
                core.info("Email not sent: one or more email configuration parameters are missing.");
                core.info("Please set MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_FROM, and MAIL_TO.");
            }


            core.info("Review email sent successfully.");

        } else {
            core.info(`Unsupported event type: ${eventName}`);
        }

    } catch (error: any) {
        core.setFailed(error.message);
    }
}

main();
