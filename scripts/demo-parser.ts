import {
  formatExpenseParseErrorReply,
  formatSavedExpenseReply,
} from "../src/application/expense-reply.js";
import { generatePublicId } from "../src/application/public-id.js";
import { parseExpenseMessage } from "../src/domain/index.js";

const message = process.argv.slice(2).join(" ").trim();
if (message.length === 0) {
  process.stderr.write(
    '用法：npm run demo:parse -- "牛肉麵 150 #約會"\n',
  );
  process.exitCode = 1;
} else {
  const result = parseExpenseMessage(message, {
    eventTimestamp: process.env.DEMO_EVENT_TIMESTAMP ?? new Date(),
    timezone: process.env.DEMO_TIMEZONE ?? "Asia/Taipei",
  });

  if (!result.ok) {
    process.stdout.write(
      `不會入帳 [${result.error.code}]\n${formatExpenseParseErrorReply(result.error)}\n`,
    );
  } else {
    process.stdout.write(
      `[解析預覽，不會寫入 DB]\n${formatSavedExpenseReply({
        publicId: generatePublicId(),
        expense: result.value,
        payerDisplayName: process.env.DEMO_PAYER_NAME ?? "你",
      })}\n`,
    );
  }
}
