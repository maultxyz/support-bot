import {
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import type { IssueKind } from "../config.js";
import { forums, links, postDetails, type PostDetail } from "../db.js";
import { commentOnIssue } from "../github.js";
import { detailsMarkdown, logWarning, SyncError } from "../sync.js";
import { asForumThread, Colors, ComponentIds, isStaff, WelcomeFields, withoutComponent } from "./util.js";

/** Asked when a forum has no questions of its own. Feature forums ask nothing unless set up to. */
export const DEFAULT_DETAIL_QUESTIONS: Record<IssueKind, string[]> = {
  support: ["Version", "Platform / OS", "Steps to reproduce", "What happened, and what did you expect?"],
  feature: [],
};

/** Discord limits for a modal: 5 inputs, each labelled with at most 45 characters. */
export const MAX_DETAIL_QUESTIONS = 5;
export const MAX_QUESTION_LENGTH = 45;
const MAX_ANSWER_LENGTH = 1000;

/** Posts with less text than this get the "Add details" button. */
const THIN_POST_LENGTH = 200;

export function detailQuestions(forumId: string) {
  const forum = forums.get(forumId);
  if (!forum) return [];
  return forum.detailQuestions ?? DEFAULT_DETAIL_QUESTIONS[forum.kind];
}

/** Whether a new post is short enough to ask for details. A starter message that couldn't be read counts. */
export function isThinPost(starter: Message | null) {
  return !starter || starter.content.trim().length < THIN_POST_LENGTH;
}

function requireDetailsContext(interaction: ButtonInteraction | ModalSubmitInteraction) {
  const context = asForumThread(interaction.channel);
  if (!context) throw new SyncError("Use this inside a post in the support or feature-request forum.");
  if (!isStaff(interaction) && interaction.user.id !== context.thread.ownerId) {
    throw new SyncError("Only the person who opened this post or staff can add its details.");
  }
  const questions = detailQuestions(context.thread.parentId!);
  if (!questions.length) throw new SyncError("This forum doesn't ask for details anymore.");
  return { ...context, questions };
}

/** The "Add details" button on the welcome message. */
export async function handleAddDetailsButton(interaction: ButtonInteraction) {
  const { questions } = requireDetailsContext(interaction);
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(ComponentIds.detailsForm)
      .setTitle("Add details")
      .addLabelComponents(
        questions.slice(0, MAX_DETAIL_QUESTIONS).map((question, index) =>
          new LabelBuilder()
            .setLabel(question.slice(0, MAX_QUESTION_LENGTH))
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId(`answer-${index}`)
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(MAX_ANSWER_LENGTH)
                .setRequired(false),
            ),
        ),
      ),
  );
}

/** The submitted details form: posts the answers, and adds them to the linked GitHub issue if there is one. */
export async function handleDetailsModal(interaction: ModalSubmitInteraction) {
  const { thread, questions } = requireDetailsContext(interaction);
  const answers: PostDetail[] = questions
    .slice(0, MAX_DETAIL_QUESTIONS)
    .map((question, index) => ({ question, answer: answerAt(interaction, index) }))
    .filter((detail) => detail.answer);
  if (!answers.length) throw new SyncError("Answer at least one question.");

  postDetails.set(thread.id, thread.guildId, answers);

  // Drop the prompt and the button from the welcome message.
  if (interaction.isFromMessage()) {
    const [welcome] = interaction.message.embeds;
    await interaction.update({
      embeds: welcome
        ? [EmbedBuilder.from(welcome).setFields(welcome.fields.filter((f) => f.name !== WelcomeFields.detailsPrompt))]
        : [],
      components: withoutComponent(interaction.message, ComponentIds.addDetails),
    });
  } else {
    await interaction.deferUpdate();
  }

  const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.brand)
        .setAuthor({ name, iconURL: interaction.user.displayAvatarURL() })
        .setTitle("📋 Details")
        .addFields(answers.map(({ question, answer }) => ({ name: question, value: answer }))),
    ],
    allowedMentions: { parse: [] },
  });

  const link = links.byThread(thread.id);
  if (link) {
    const body = [`📋 **${name}** added details [on Discord](${thread.url}):`, "", detailsMarkdown(answers)].join("\n");
    await commentOnIssue(link.repo, link.issueNumber, body).catch(logWarning("add details to GitHub issue"));
  }
}

function answerAt(interaction: ModalSubmitInteraction, index: number) {
  try {
    return interaction.fields.getTextInputValue(`answer-${index}`).trim();
  } catch {
    // The forum's questions changed while the form was open.
    return "";
  }
}
