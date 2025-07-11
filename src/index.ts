import * as core from "@actions/core";
import { App, BlockAction, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN || "";
const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
const slackAppToken = process.env.SLACK_APP_TOKEN || "";
const channel_id = process.env.SLACK_CHANNEL_ID || "";
const baseMessageTs = core.getInput("baseMessageTs");
const requiredApproversInput = core
  .getInput("approvers", { required: true, trimWhitespace: true })
  ?.split(",");

// Will be filled with user IDs (Uxxxx) and user group IDs (Sxxxx)
let requiredApprovers: string[] = [];
let userGroupIds: string[] = [];
let userGroupMentions: string[] = [];
const minimumApprovalCount = Number(core.getInput("minimumApprovalCount")) || 1;
const baseMessagePayload = JSON.parse(
  core.getMultilineInput("baseMessagePayload").join("")
);
const approvers: string[] = [];

const successMessagePayload = JSON.parse(
  core.getMultilineInput("successMessagePayload").join("")
);
const failMessagePayload = JSON.parse(
  core.getMultilineInput("failMessagePayload").join("")
);

const app = new App({
  token: token,
  signingSecret: signingSecret,
  appToken: slackAppToken,
  socketMode: true,
  port: 3000,
  logLevel: LogLevel.DEBUG,
});

// We'll check for minimum after expanding user groups
function hasPayload(inputs: any) {
  return inputs.text?.length > 0 || inputs.blocks?.length > 0;
}

async function run(): Promise<void> {
  try {
    const web = new WebClient(token);

    // Helper: get user IDs from a user group (subteam)
    async function getUserIdsFromUserGroup(usergroupId: string): Promise<string[]> {
      try {
        const res = await web.usergroups.users.list({ usergroup: usergroupId });
        if (res.ok && Array.isArray(res.users)) {
          return res.users as string[];
        }
      } catch (e) {
        console.error(`Failed to fetch users for user group ${usergroupId}:`, e);
      }
      return [];
    }

    // Parse requiredApproversInput for user groups (subteams) and users
    // Slack user group mention: <@Uxxxx> for user, <@subteam^Sxxxx> for user group
    // Accept both Sxxxx and <@subteam^Sxxxx> for user group
    for (const entry of requiredApproversInput) {
      const trimmed = entry.trim();
      // User group: <@subteam^SXXXX> or SXXXX
      const userGroupMatch = trimmed.match(/^<@subteam\^(S[A-Z0-9]+)>$/i) || trimmed.match(/^(S[A-Z0-9]+)$/i);
      if (userGroupMatch) {
        const groupId = userGroupMatch[1] || userGroupMatch[0];
        userGroupIds.push(groupId);
        userGroupMentions.push(`<@subteam^${groupId}>`);
        continue;
      }

      const userMatch = trimmed.match(/^<@(U[A-Z0-9]+)>$/i) || trimmed.match(/^(U[A-Z0-9]+)$/i);
      if (userMatch) {
        requiredApprovers.push(userMatch[1] || userMatch[0]);
        continue;
      }
      // fallback: treat as user id
      requiredApprovers.push(trimmed);
    }

    // Expand user groups to user IDs
    for (const groupId of userGroupIds) {
      const users = await getUserIdsFromUserGroup(groupId);
      for (const u of users) {
        if (!requiredApprovers.includes(u)) {
          requiredApprovers.push(u);
        }
      }
    }

    if (minimumApprovalCount > requiredApprovers.length) {
      console.error(
        `Error: Insufficient approvers. Minimum required approvers not met. (Have: ${requiredApprovers.length}, Need: ${minimumApprovalCount})`
      );
      process.exit(1);
    }

    const github_server_url = process.env.GITHUB_SERVER_URL || "";
    const github_repos = process.env.GITHUB_REPOSITORY || "";
    const run_id = process.env.GITHUB_RUN_ID || "";
    const run_number = process.env.GITHUB_RUN_NUMBER || "";
    const run_attempt = process.env.GITHUB_RUN_ATTEMPT || "";
    const workflow = process.env.GITHUB_WORKFLOW || "";
    const aid = `${github_repos}-${workflow}-${run_id}-${run_number}-${run_attempt}`;
    const runnerOS = process.env.RUNNER_OS || "";
    const actor = process.env.GITHUB_ACTOR || "";
    const actionsUrl = `${github_server_url}/${github_repos}/actions/runs/${run_id}`;
    const mainMessagePayload = hasPayload(baseMessagePayload)
      ? baseMessagePayload
      : {
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "GitHub Actions Approval Request",
              },
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*GitHub Actor:*\n${actor}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Repos:*\n${github_server_url}/${github_repos}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Actions URL:*\n${actionsUrl}`,
                },
                {
                  type: "mrkdwn",
                  text: `*GITHUB_RUN_ID:*\n${run_id}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Workflow:*\n${workflow}`,
                },
                {
                  type: "mrkdwn",
                  text: `*RunnerOS:*\n${runnerOS}`,
                },
              ],
            },
          ],
        };

    const renderReplyTitle = () => {
      // Tag user groups (Slack will notify the group)
      let groupMentions = userGroupMentions.length > 0 ? userGroupMentions.join(", ") : "";
      // List remaining individual users
      let userMentions = requiredApprovers.length > 0 ? requiredApprovers.map((v) => `<@${v}>`).join(", ") : "";
      let approverMentions = approvers.length > 0 ? `Approvers: ${approvers.map((v) => `<@${v}>`).join(", ")} ` : "";
      let mentionLine = [groupMentions, userMentions].filter(Boolean).join(", ");
      return {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Required Approvers Count:* ${minimumApprovalCount}\n*Remaining Approvers:* ${mentionLine}\n${approverMentions}\n`,
        },
      };
    };

    const renderReplyBody = () => {
      if (minimumApprovalCount > approvers.length) {
        return {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                emoji: true,
                text: "approve",
              },
              style: "primary",
              value: aid,
              action_id: "slack-approval-approve",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                emoji: true,
                text: "reject",
              },
              style: "danger",
              value: aid,
              action_id: "slack-approval-reject",
            },
          ],
        };
      }
      return {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Approved :white_check_mark:`,
        },
      };
    };

    function approve(userId: string) {
      const idx = requiredApprovers.findIndex((user) => user === userId);
      if (idx === -1) {
        return "notApproval";
      }
      requiredApprovers.splice(idx, 1);
      approvers.push(userId);

      if (approvers.length < minimumApprovalCount) {
        return "remainApproval";
      }

      return "approved";
    }

    const mainMessage = baseMessageTs
      ? await web.chat.update({
          channel: channel_id,
          ts: baseMessageTs,
          ...mainMessagePayload,
        })
      : await web.chat.postMessage({
          channel: channel_id,
          ...mainMessagePayload,
        });

    const replyMessage = await web.chat.postMessage({
      channel: channel_id,
      thread_ts: mainMessage.ts,
      text: "",
      blocks: [renderReplyTitle(), renderReplyBody()],
    });

    core.setOutput("mainMessageTs", mainMessage.ts);
    core.setOutput("replyMessageTs", replyMessage.ts);

    async function cancelHandler() {
      await web.chat.update({
        ts: mainMessage.ts!,
        channel: channel_id,
        ...(hasPayload(failMessagePayload)
          ? failMessagePayload
          : mainMessagePayload),
      });
      await web.chat.update({
        ts: replyMessage.ts!,
        text: "",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Canceled :radio_button: :leftwards_arrow_with_hook:`,
            },
          },
        ],
        channel: channel_id,
      });
      process.exit(1);
    }

    process.on("SIGTERM", cancelHandler);
    process.on("SIGINT", cancelHandler);
    process.on("SIGBREAK", cancelHandler);

    app.action(
      "slack-approval-approve",
      async ({ ack, client, body, logger, action }) => {
        await ack();
        if (action.type !== "button") {
          return;
        }
        if (action.value !== aid) {
          return;
        }
        const approveResult = approve(body.user.id);

        try {
          if (approveResult === "approved") {
            await client.chat.update({
              ts: mainMessage.ts || "",
              channel: body.channel?.id || "",
              ...(hasPayload(successMessagePayload)
                ? successMessagePayload
                : mainMessagePayload),
            });
          }
          await client.chat.update({
            channel: body.channel?.id || "",
            ts: replyMessage?.ts || "",
            text: "",
            blocks: [renderReplyTitle(), renderReplyBody()],
          });
        } catch (error) {
          logger.error(error);
        }

        if (approveResult === "approved") {
          process.exit(0);
        }
      }
    );

    app.action(
      "slack-approval-reject",
      async ({ ack, client, body, logger, action }) => {
        await ack();
        if (action.type !== "button") {
          return;
        }
        if (action.value !== aid) {
          return;
        }
        try {
          const response_blocks = (<BlockAction>body).message?.blocks;
          response_blocks.pop();
          response_blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Rejected by <@${body.user.id}> :x:`,
            },
          });

          await client.chat.update({
            ts: mainMessage.ts || "",
            channel: body.channel?.id || "",
            ...(hasPayload(failMessagePayload)
              ? failMessagePayload
              : mainMessagePayload),
          });

          await client.chat.update({
            channel: body.channel?.id || "",
            ts: replyMessage?.ts || "",
            text: "",
            blocks: response_blocks,
          });
        } catch (error) {
          logger.error(error);
        }

        process.exit(1);
      }
    );

    (async () => {
      await app.start(3000);
      console.log("Waiting Approval reaction.....");
    })();
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();

