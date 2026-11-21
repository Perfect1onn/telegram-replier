import OpenAI from 'openai';

export class OpenAIEmbeddings {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    if (!model.trim()) throw new Error('Embedding model required');

    this.client = client;
    this.model = model;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    if (
      !texts.length ||
      texts.length > 32 ||
      texts.some((text) => !text.trim() || text.length > 8192)
    )
      throw new Error('Invalid embedding batch');

    const response = await this.client.embeddings.create({
      model: this.model,
      input: [...texts],
      encoding_format: 'float',
    });
    const ordered = [...response.data].sort((a, b) => a.index - b.index);

    if (ordered.length !== texts.length || ordered.some((row, index) => row.index !== index))
      throw new Error('Incomplete embedding response');

    return ordered.map(({ embedding }) => {
      if (embedding.length !== 1536 || embedding.some((value) => !Number.isFinite(value)))
        throw new Error('Embedding dimension mismatch');

      return embedding;
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([query]);

    if (!vector) throw new Error('Missing query embedding');

    return vector;
  }
}
