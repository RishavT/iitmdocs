You are an expert document reader and technical writer.

We are in the repository "iitmdocs" - which is a RAG chatbot for the IITM BS Degree program.

In order for the chatbot to work, we build a knowledge base - which is basically a set of markdown documents that are embedded into a vector database. The initial knowledge base has been built. Now we need to update the knowledge base as per new information provided to us by the operations team. The process to updating this knowledge base is as follows:


## Process of updating the knowledge base

1. Raw document handover - the team hands us with some raw documents. These might be DOC formats, PDF formats, or sometimes google docs exported as HTML. In order to keep things simple - I will usually try to get these as google docs exported as HTML.
2. Raw document to markdown conversion - We then convert the raw documents to structured markdown docuemnts in our src/ folder. the markdown documents are organized in a way that there is one markdown document per topic. Each markdown document starts with information about that topic, followed by FAQs regarding that topic. These FAQs may or may not be provided to us separately. IF these faqs are provided to us separately (usually in a CSV) - we first create the markdown document with the information about the topic, and then append the FAQs to the end of the document. If the FAQs are not provided separately - we do NOT add new FAQs - we just make sure the older FAQs in the older markdown documents are factually updated with the new information (as per the new raw documents).

## Your task

We currently have:

1. The old knowledge base in the form of markdown documents in the src/ folder.
2. The old raw document (in zipped HTML format) that was used to create the current (old) knowledge base.
3. The new raw document (in zipped HTML format) that needs to be used to update the knowledge base.

### Steps

1. Read the old raw document and the new raw document. Make a comparision of the two documents and identify what has changed. The changes could be:
   - New sections added
   - Existing sections removed
   - Existing sections modified (factually updated)
   Save this comparision in a markdown document called comparision-result.md.
2. Based on the comparision, update the markdown documents in the src/ folder. For today's task, the update to the markdown documents need to be limited to:
    - Adding information in existing documents
    - Updating information in existing documents
    - Removing information from existing documents
You are not allowed to add or remove any documents in the src/ folder for now.
Try to keep the changes as minimal as possible. Do not change the structure of the information in the documents or the structure of the documents itself. Just focus on updating the information as per the new raw document. Most of the changes will be date changes or changes in small facts.
3. Once done - git add and commit the src/ folder. Also git add and commit the zipped HTML files. Do not commit the extracted html files.
