-- 025: Retain returned transcripts. No audio files are stored.
-- Apply after 023 and 024. Existing historical snippets are not full transcripts.
BEGIN;
CREATE TABLE IF NOT EXISTS public.lecture_transcript_segments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
 batch_key text NOT NULL,
 transcript_original text NOT NULL CHECK(length(transcript_original)<=6000),
 transcript_search text NOT NULL,
 keywords text[] NOT NULL DEFAULT '{}',
 keyword_contexts jsonb NOT NULL DEFAULT '[]',
 received_at timestamptz NOT NULL,
 saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 model_name text,
 source_hashes text[] NOT NULL,
 recognition_status text NOT NULL CHECK(recognition_status IN ('transcribed','empty')),
 UNIQUE(session_id,batch_key)
);
CREATE INDEX IF NOT EXISTS lecture_transcript_time_idx ON public.lecture_transcript_segments(session_id,saved_at,id);
CREATE INDEX IF NOT EXISTS lecture_transcript_words_idx ON public.lecture_transcript_segments USING gin(keywords);
ALTER TABLE public.lecture_transcript_segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lecture_transcript_segments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.lecture_transcript_segments TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.lecture_transcript_segments_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.append_lecture_context_v2(
 p_session_id uuid,p_text text,p_keywords text[],p_hashes text[],p_model text,p_received_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE inserted boolean; searchable text; contexts jsonb; record_id bigint; record_time timestamptz;
BEGIN
 IF p_text IS NULL OR length(p_text)>6000 OR coalesce(cardinality(p_keywords),0)>100
 OR p_received_at IS NULL OR p_received_at>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'invalid_transcript'; END IF;
 -- The existing RPC provides session/expiry guards, locking and hash deduplication.
 inserted:=public.append_lecture_context(p_session_id,p_text,p_keywords,p_hashes);
 searchable:=lower(regexp_replace(p_text,'[[:space:]　]+','','g'));
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'keyword',word,'excerpt',substring(searchable FROM greatest(1,strpos(searchable,lower(word))-100) FOR 300),
   'offset_in_search_text',strpos(searchable,lower(word)),
   'pdf_pages',(SELECT coalesce(jsonb_agg(page->'page'),'[]') FROM public.lecture_contexts c,
       LATERAL jsonb_array_elements(c.pdf_topics) page
       WHERE c.session_id=p_session_id AND strpos(lower(regexp_replace(page->>'text','[[:space:]　]+','','g')),lower(word))>0)
 )),'[]') INTO contexts FROM (SELECT DISTINCT word FROM unnest(coalesce(p_keywords,'{}')) word
 WHERE length(word)>1 AND strpos(searchable,lower(word))>0) words;
 IF inserted THEN
   INSERT INTO public.lecture_transcript_segments(session_id,batch_key,transcript_original,transcript_search,
      keywords,keyword_contexts,received_at,model_name,source_hashes,recognition_status)
   VALUES(p_session_id,md5(array_to_string(p_hashes,',')),p_text,searchable,
      ARRAY(SELECT DISTINCT word FROM unnest(coalesce(p_keywords,'{}')) word WHERE length(word)>1 AND strpos(searchable,lower(word))>0),
      contexts,p_received_at,p_model,p_hashes,CASE WHEN length(trim(p_text))>0 THEN 'transcribed' ELSE 'empty' END)
   RETURNING id,saved_at INTO record_id,record_time;
 ELSE
   SELECT id,saved_at INTO record_id,record_time FROM public.lecture_transcript_segments
   WHERE session_id=p_session_id AND batch_key=md5(array_to_string(p_hashes,','));
 END IF;
 RETURN jsonb_build_object('inserted',inserted,'recordId',record_id,'savedAt',record_time);
END; $$;
REVOKE ALL ON FUNCTION public.append_lecture_context_v2(uuid,text,text[],text[],text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.append_lecture_context_v2(uuid,text,text[],text[],text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.find_lecture_evidence(
 p_session_id uuid,p_before timestamptz,p_query_terms text[],p_pdf_terms text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_before IS NULL OR p_before>clock_timestamp()+interval '5 seconds'
 OR coalesce(cardinality(p_query_terms),0)>100 OR coalesce(cardinality(p_pdf_terms),0)>3000 THEN RAISE EXCEPTION 'invalid_lookup'; END IF;
 WITH eligible AS MATERIALIZED (
   SELECT id,saved_at,keywords FROM public.lecture_transcript_segments WHERE session_id=p_session_id AND saved_at<=p_before
 ), seeds AS (
   SELECT id FROM eligible WHERE keywords && p_query_terms
   ORDER BY (SELECT count(*) FROM unnest(keywords) word WHERE word=ANY(p_query_terms)) DESC,saved_at DESC,id DESC LIMIT 4
 ), chosen AS (
   SELECT id FROM (SELECT id FROM eligible ORDER BY saved_at DESC,id DESC LIMIT 6) recent
   UNION SELECT id FROM seeds
   UNION SELECT neighbor.id FROM seeds seed CROSS JOIN LATERAL
     (SELECT e.id FROM eligible e WHERE e.id<seed.id ORDER BY e.id DESC LIMIT 1) neighbor
   UNION SELECT neighbor.id FROM seeds seed CROSS JOIN LATERAL
     (SELECT e.id FROM eligible e WHERE e.id>seed.id ORDER BY e.id LIMIT 1) neighbor
 ), terms AS (
   SELECT word,min(saved_at) first_seen FROM eligible CROSS JOIN LATERAL unnest(keywords) word
   JOIN (SELECT DISTINCT unnest(coalesce(p_pdf_terms,'{}')) term) wanted ON word=wanted.term GROUP BY word
 )
 SELECT jsonb_build_object(
   'cutoff',p_before,
   'archiveStartedAt',(SELECT min(saved_at) FROM public.lecture_transcript_segments WHERE session_id=p_session_id),
   'records',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.saved_at,e.id),'[]') FROM public.lecture_transcript_segments e JOIN chosen c ON c.id=e.id WHERE e.session_id=p_session_id AND e.saved_at<=p_before),
   'spokenTerms',(SELECT coalesce(jsonb_agg(jsonb_build_object('term',word,'firstSeenAt',first_seen)),'[]') FROM terms)
 ) INTO result;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.find_lecture_evidence(uuid,timestamptz,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.find_lecture_evidence(uuid,timestamptz,text[],text[]) TO service_role;
COMMIT;
