import {
  Config,
  Console,
  Context,
  Duration,
  Effect,
  Layer,
  pipe,
} from "effect";
import { JsonWebTokenError, sign } from "jsonwebtoken";
import { Errors, ServerClient, type TemplatedMessage } from "postmark";
import type { MessageSendingResponse } from "postmark/dist/client/models";

/*
 * TODO:
 * Change the following account based on the user you want to send the email to
 */
const account = {
  uid: "17006",
  type: "PARTNER",
  pocEmail: "mrevanzak@gmail.com",
};

/****************************************************************************************
 ********************************** Postmark Service ************************************
 ****************************************************************************************/
class PostmarkError extends Errors.PostmarkError {
  readonly _tag = "PostmarkError";
}
class PostmarkService extends Context.Tag("PostmarkService")<
  PostmarkService,
  {
    readonly sendEmailWithTemplate: (
      template: TemplatedMessage,
    ) => Effect.Effect<MessageSendingResponse, PostmarkError>;
  }
>() {}
const PostmarkLive = Layer.effect(
  PostmarkService,
  Effect.gen(function* () {
    const key = yield* Config.string("POSTMARK_KEY");
    const client = new ServerClient(key);

    const templateAlias = yield* Config.string("POSTMARK_TEMPLATE_ID");

    return {
      sendEmailWithTemplate: (template) =>
        Effect.tryPromise({
          try: () =>
            client.sendEmailWithTemplate({
              TemplateAlias: templateAlias,
              ...template,
            }),
          catch: (error) => new PostmarkError(`Failed to send email: ${error}`),
        }),
    };
  }),
);

/****************************************************************************************
 ********************************** Jwt Service *****************************************
 ****************************************************************************************/
class JwtError extends JsonWebTokenError {
  readonly _tag = "JwtError";
}
class JwtService extends Context.Tag("JwtService")<
  JwtService,
  {
    readonly sign: (payload: {
      uid: string;
      type: string;
    }) => Effect.Effect<string, JwtError>;
  }
>() {}
const JwtLive = Layer.effect(
  JwtService,
  Effect.gen(function* () {
    const secret = yield* Config.string("JWT_SECRET");

    return {
      sign: (payload) =>
        Effect.try({
          try: () =>
            sign(payload, secret, {
              expiresIn: "30d",
            }),
          catch: (error) => new JwtError(`Failed to sign token: ${error}`),
        }),
    };
  }),
);

/****************************************************************************************
 ********************************** Main Program ****************************************
 ****************************************************************************************/
const program = Effect.gen(function* () {
  yield* Effect.logInfo(`Sending email to ${account.pocEmail}...`);

  const jwtService = yield* JwtService;
  const token = yield* jwtService.sign({
    uid: account.uid,
    type: account.type,
  });

  const postmark = yield* PostmarkService;
  const HOSTNAME = yield* Config.string("HOSTNAME");
  const FROM_EMAIL = yield* Config.string("FROM_EMAIL");
  yield* postmark
    .sendEmailWithTemplate({
      TemplateModel: {
        name: "John Doe",
        url: `${HOSTNAME}/submit-partner?token=${token}`,
        webPage: HOSTNAME,
      },
      From: FROM_EMAIL,
      To: account.pocEmail,
    })
    .pipe(
      Effect.tapBoth({
        onSuccess: () => Effect.logInfo("Email sent!"),
        onFailure: () => Effect.logInfo("Email failed to send"),
      }),
      Effect.retry({ times: 3 }),
      Effect.catchTag("PostmarkError", (error) => Console.error(error.message)),
      Effect.withSpan("send-email"),
    );
});

const runnable = Effect.provide(program, Layer.merge(PostmarkLive, JwtLive));
Effect.runPromise(
  pipe(
    runnable,
    Effect.timeout(Duration.seconds(3)),
    Effect.catchTag("ConfigError", (error) =>
      Console.error("Missing config on environment", error),
    ),
    Effect.catchTag("TimeoutException", (error) =>
      Console.error("3 seconds timeout reached", error),
    ),
  ),
);
