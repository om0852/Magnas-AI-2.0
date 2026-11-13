import { redirect } from 'next/navigation';

/** The chat is the home page now (ADR 0018). */
export default function ChatPage(): never {
  redirect('/');
}
