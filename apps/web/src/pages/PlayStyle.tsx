// The Play style tab: the console's menu 18 (playing style), menu 21 (deep profiles) and menu 22
// (hit & run). Routes: #/style (playing style), #/style/profiles and #/style/profiles/<name> (the
// long read for one player), #/style/hitrun and #/style/hitrun/<name> (one player's nights).
import type { Ctx } from "../context.ts";
import { useHandLogs } from "../handlogs.ts";
import type { HandScopePayload } from "../handtypes.ts";
import { scopeWords } from "../handformat.ts";
import { href } from "../router.ts";
import { Downloads } from "../components/downloads.tsx";
import { AddLogHint, HandStatus, Notes } from "../components/handlines.tsx";
import { HitRunPlayer, HitRunView } from "../components/hitrun.tsx";
import { NightsCard, ProfileDetail, ProfilesView, StyleCard, UnloggedCard } from "../components/playstyle.tsx";

const SECTIONS = [
  { path: "", label: "Playing style" },
  { path: "profiles", label: "Deep profiles" },
  { path: "hitrun", label: "Hit & run" },
];

export function PlayStylePage({ ctx, section, person }: { ctx: Ctx; section: string; person: string }) {
  const hand = useHandLogs(ctx);
  return (
    <>
      <h1>Play style</h1>
      <SectionNav section={section} />
      {hand.status === "ready" && hand.data !== undefined ? (
        <PlayStyleBody ctx={ctx} data={hand.data} section={section} person={person} />
      ) : (
        <HandStatus hand={hand} />
      )}
    </>
  );
}

function SectionNav({ section }: { section: string }) {
  return (
    <nav className="subtabs" aria-label="Play style pages">
      {SECTIONS.map((s) => (
        <a
          key={s.path}
          href={s.path === "" ? href("style") : href("style", s.path)}
          className={section === s.path ? "active" : ""}
          aria-current={section === s.path ? "page" : undefined}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

// One section of the page, from the results for the scope on screen.
export function PlayStyleBody({
  ctx,
  data,
  section,
  person,
}: {
  ctx: Ctx;
  data: HandScopePayload;
  section: string;
  person: string;
}) {
  if (data.games === 0) {
    return <p className="lede">No games in this scope. Pick another folder or date range above.</p>;
  }
  const scope = scopeWords(ctx.choice);
  switch (section) {
    case "":
      return (
        <>
          <p className="lede">{`Hand-log statistics for ${scope}: ${data.logged} of ${data.games} games have a log.`}</p>
          <Notes messages={data.messages} />
          {data.logged === 0 ? (
            <p className="lede">
              No hand logs in scope. <AddLogHint canWrite={ctx.payload.canWrite} />
            </p>
          ) : (
            <>
              <StyleCard style={data.style} />
              <NightsCard data={data} tz={ctx.tz} />
            </>
          )}
          {data.logged < data.games ? (
            (data.unlogged ?? []).length > 0 ? (
              <UnloggedCard data={data} tz={ctx.tz}>
                <p className="sub">
                  Games without a log: <AddLogHint canWrite={ctx.payload.canWrite} />
                </p>
              </UnloggedCard>
            ) : (
              <p className="sub">
                Games without a log: <AddLogHint canWrite={ctx.payload.canWrite} />
              </p>
            )
          ) : null}
          <Downloads exports={data.exports} />
        </>
      );
    case "profiles":
      return person === "" ? (
        <>
          <Notes messages={data.messages} />
          <ProfilesView data={data} scope={scope} canWrite={ctx.payload.canWrite} />
          <Downloads exports={data.exports} />
        </>
      ) : (
        <>
          <Notes messages={data.messages} />
          <ProfileDetail data={data} person={person} />
        </>
      );
    case "hitrun":
      return person === "" ? (
        <>
          <Notes messages={data.messages} />
          <HitRunView data={data} scope={scope} canWrite={ctx.payload.canWrite} />
          <Downloads exports={data.exports} />
        </>
      ) : (
        <>
          <Notes messages={data.messages} />
          <HitRunPlayer data={data} person={person} tz={ctx.tz} />
        </>
      );
    default:
      return (
        <>
          <p className="lede">That page does not exist.</p>
          <a href={href("style")}>Back to playing style</a>
        </>
      );
  }
}
