package game

import "hackaton/server/internal/db"

func ChoicesFor(kind string) []Choice {
	switch kind {
	case "chef":
		return []Choice{
			{1, "不要辣", "Bùyào là", "Без острого, пожалуйста", "order"},
			{2, "不要花生", "Bùyào huāshēng", "Без арахиса, пожалуйста", "order"},
			{3, "变态辣", "Biàntài là", "Максимально остро!", "provoke"},
			{4, "对不起", "Duìbuqǐ", "Извините, я вернусь", "leave"},
		}
	case "guard":
		return []Choice{
			{1, "这是我的票", "Zhè shì wǒ de piào", "Вот мой билет", "documents"},
			{2, "请问怎么走", "Qǐngwèn zěnme zǒu", "Подскажите дорогу, пожалуйста", "directions"},
			{3, "给你钱", "Gěi nǐ qián", "Возьмите деньги и пропустите", "bribe"},
			{4, "对不起", "Duìbuqǐ", "Извините", "leave"},
		}
	default:
		return Choices()
	}
}

// Enforce keeps scenario rules authoritative even when the model disagrees.
func Enforce(p Reply, r db.Relation, choice *Choice, npc NPC) Reply {
	if npc.Kind == "guard" {
		p.Price = r.Price
		if choice != nil && choice.Type == "bribe" {
			p.AggroDelta = 100
			p.MianziDelta = -30
			p.State = "AGGRO"
			p.Emotion = "angry"
		}
	}
	if r.State == "AGGRO" && choice != nil && (choice.Type == "haggle" || choice.Type == "bluff") {
		p.Price = r.Price
	}
	next := Apply(r, p)
	p.State = next.State
	if next.State == "AGGRO" {
		p.Emotion = "angry"
	} else if next.State == "FLATTERED" {
		p.Emotion = "happy"
	}
	return p
}
