// Stoplist v1 (spec 5.4). Written before any model output was inspected.
// Lower-case only. Must never contain names of people, systems, products, hosts,
// or any word that could be a fabricated fact (e.g. redis, postgres, cache, deploy).
// Changes after the first commit go through eval/tuning-log.md (spec 5.5).
export const STOPLIST_VERSION = 1;

const WORDS = `
a about above across after again against all almost also although always am among an and any anyone
anything are around as at away be became because become been before being below between both but by
can cannot could did do does doing done down during each either else enough even ever every few for
from further get gets got had has have having he her here hers herself him himself his how however if
in into is it its itself just least less let like made make many may me might more most much must my
myself neither no nor not now of off often on once one only onto or other others otherwise our ours
out over own per perhaps quite rather same shall she should since so some something still such than
that the their theirs them then there therefore these they this those though through thus to too
toward under until up upon us very via was we were what when whenever where whether which while who
whom whose why will with within without would yes yet you your yours
two three four five six seven eight nine ten eleven twelve
summary impact timeline incident incidents action actions item items factor factors possible first
last note notes contributing root cause causes caused resolved started ended team engineer engineers
customers users service services next later earlier following previous
half roughly approximately nearly completed finished complete finish decided
reported noted noticed observed confirmed
monday tuesday wednesday thursday friday saturday sunday
january february march april june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun
utc gmt api cpu http https dns tcp url ip ui id ok
on-call follow-up read-only roll-back rollback post-mortem long-running e.g i.e etc
`;

export const STOPWORDS = Object.freeze([...new Set(WORDS.split(/\s+/).filter(Boolean))]);
export const STOPSET = new Set(STOPWORDS);
