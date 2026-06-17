# scold-reminder — Intention

PLans for this kind of plugins for me:
- scold-reminder

Intention: 
- pi usually forgot to admit their wrong doing , they are skipping stuffs that is in the instruction prompt. We will build a dynamicaly extension that randomly keep inject message / reminder that act as human is DEMANDING themself to aligned with the requirement; 
- usually when remind like: "did you really use the skills as instructed" "did you really followed all the skills steps? List steps that you are NOT followed it " "did you run ADHOC cmd. That is GATED." "admit the things you did that is EXPLICITLY instructed NOT TO" ... things like that. 
- this is to leverage the behavior of AI AGENT to ENFORCE it follow the requirement (even with a bit of non-deterministic , it is better than zero)

Spec: 
Configuration will be having global and local . In yml. 
it (ext: extension) will have multiple modes (each of these "<char>" bullet is the mode , which can be combine together depend on it capability)
a. have the configured list of sentences , then randomly ext will pick 1 line per <X> turns of the sub agents and inject it in as reminder. 
a1. these picked lines can use fuzzy / bm25 / embedding to search for most relavent line: base on user / AI AGENT message ; then inject it ; 
b. yml can config in pair of: 
- instruction / reminder; 
initially instruction will inject to the session (like SYTEM.md of pi)
then having the reminder from time to  time like (a , a1)
