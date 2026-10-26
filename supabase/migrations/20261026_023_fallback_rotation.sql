-- SupporTalk 023: durable fallback selection. Apply after recovered 020/022.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.verify_reaction_room_access(uuid,uuid,uuid,uuid,text)') IS NULL THEN
 RAISE EXCEPTION 'Required 020/022 objects are missing'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.reaction_fallback_selections (
 session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
 mode text NOT NULL CHECK(mode IN ('empathy','lecture_bridge','neutral')),
 last_id text,
 selection_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,mode)
);
ALTER TABLE public.reaction_fallback_selections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reaction_fallback_selections FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.reaction_fallback_selections TO service_role;
CREATE OR REPLACE FUNCTION public.choose_reaction_fallback(p_session_id uuid,p_mode text,p_candidate_ids text[])
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous text; count_so_far bigint; chosen text; idx int; amount int;
BEGIN
 amount=cardinality(p_candidate_ids);
 IF p_mode NOT IN ('empathy','lecture_bridge','neutral') OR amount IS NULL OR amount<2 OR amount>100
 OR EXISTS(SELECT 1 FROM unnest(p_candidate_ids) item WHERE item IS NULL OR length(item)>100)
 OR (SELECT count(DISTINCT item) FROM unnest(p_candidate_ids) item)<>amount
 THEN RAISE EXCEPTION 'invalid_fallback_candidates'; END IF;
 INSERT INTO public.reaction_fallback_selections(session_id,mode) VALUES(p_session_id,p_mode) ON CONFLICT DO NOTHING;
 SELECT last_id,selection_count INTO previous,count_so_far FROM public.reaction_fallback_selections WHERE session_id=p_session_id AND mode=p_mode FOR UPDATE;
 idx=(count_so_far%amount)::int+1;
 chosen=p_candidate_ids[idx];
 IF chosen=previous THEN chosen=p_candidate_ids[(idx%amount)+1]; END IF;
 UPDATE public.reaction_fallback_selections SET last_id=chosen,selection_count=selection_count+1 WHERE session_id=p_session_id AND mode=p_mode;
 RETURN chosen;
END $$;
REVOKE ALL ON FUNCTION public.choose_reaction_fallback(uuid,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.choose_reaction_fallback(uuid,text,text[]) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
