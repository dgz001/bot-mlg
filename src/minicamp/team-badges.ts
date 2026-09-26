import {worldCupCandidates} from './nations.ts';
import {minicampClubs} from './clubs.ts';

// Stable visual labels for the MLG pools. Custom teams get neutral colours.
const flags=['🇪🇸','🇦🇷','🇫🇷','🏴','🇧🇷','🇲🇦','🇵🇹','🇧🇪','🇳🇱','🇲🇽','🇨🇴','🇩🇪','🇭🇷','🇨🇭','🇮🇹','🇺🇸','🇯🇵','🇸🇳','🇳🇴','🇺🇾','🇩🇰','🇮🇷','🇦🇹','🇪🇬','🇪🇨','🇳🇬','🇹🇷','🇦🇺','🇩🇿','🇨🇦','🇨🇮','🇰🇷','🇵🇾','🇵🇱'];
const nationBadges=new Map(worldCupCandidates.map((name,index)=>[name,flags[index]!]));
// Historic matches retain their flag even when a selection leaves the new-draw pool.
nationBadges.set('Ucrânia','🇺🇦');nationBadges.set('Rússia','🇷🇺');
// England's football flag is the St George cross, rather than the UK flag.
nationBadges.set('Inglaterra','🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}');
const colours:Record<string,string>={
 Arsenal:'🔴⚪','Manchester United':'🔴⚫',Barcelona:'🔵🔴','Atlético de Madrid':'🔴⚪',
 'Bayern de Munique':'🔴⚪','Borussia Dortmund':'🟡⚫','Bayer Leverkusen':'🔴⚫',
 'Inter de Milão':'🔵⚫','AC Milan':'🔴⚫',Juventus:'⚫⚪',Napoli:'🔵⚪',Roma:'🟡🔴',
 Lazio:'🔵⚪',Atalanta:'🔵⚫',Fiorentina:'🟣⚪',Bologna:'🔴🔵',Torino:'🔴⚪',Genoa:'🔴🔵',
 'Paris Saint-Germain':'🔵🔴',Monaco:'🔴⚪','Olympique de Marseille':'🔵⚪',Lyon:'🔴🔵',
 Lille:'🔴⚪',Lens:'🔴🟡',Rennes:'🔴⚫',Nice:'🔴⚫',
 Palmeiras:'🟢⚪',Flamengo:'🔴⚫','São Paulo':'🔴⚪',Corinthians:'⚫⚪',
 Fluminense:'🟢🔴',Botafogo:'⚫⚪','Vasco da Gama':'⚫⚪',Internacional:'🔴⚪',
 Grêmio:'🔵⚫','Atlético Mineiro':'⚫⚪',Cruzeiro:'🔵⚪',Bahia:'🔵🔴',
 Fortaleza:'🔴🔵','Athletico Paranaense':'🔴⚫',Santos:'⚫⚪',
 'Inter Miami':'🩷⚫','LA Galaxy':'⚪🟡','Los Angeles FC':'⚫🟡',
 'New York City FC':'🔵⚪','New York Red Bulls':'🔴⚪','Orlando City':'🟣⚪',
 'Seattle Sounders':'🟢🔵','Atlanta United':'🔴⚫',
 'Al-Hilal':'🔵⚪','Al-Nassr':'🟡🔵','Al-Ittihad':'🟡⚫','Al-Ahli':'🟢⚪','Al-Shabab':'⚪⚫',
 Ajax:'🔴⚪','PSV Eindhoven':'🔴⚪',Feyenoord:'🔴⚪',
 Benfica:'🔴⚪','Sporting CP':'🟢⚪',Porto:'🔵⚪',
 Galatasaray:'🟡🔴',Fenerbahçe:'🟡🔵',Beşiktaş:'⚫⚪',Celtic:'🟢⚪',Rangers:'🔵⚪',
 'Club América':'🟡🔵','CD Guadalajara':'🔴⚪',Monterrey:'🔵⚪','Tigres UANL':'🟡🔵',
 'Cruz Azul':'🔵⚪','Pumas UNAM':'🔵🟡',
 'Boca Juniors':'🔵🟡','River Plate':'⚪🔴','Racing Club':'🔵⚪','San Lorenzo':'🔴🔵',
 'Colo-Colo':'⚪⚫','Universidad de Chile':'🔵🔴',
 'Atlético Nacional':'🟢⚪',Millonarios:'🔵⚪','América de Cali':'🔴⚪',
 'Barcelona de Guayaquil':'🟡⚫','LDU Quito':'⚪🔴',
 Peñarol:'🟡⚫','Nacional do Uruguai':'🔵🔴',
 'Shakhtar Donetsk':'🟠⚫','Dynamo Kyiv':'🔵⚪',
 'Vissel Kobe':'🔴⚪','Yokohama F. Marinos':'🔵🔴','Urawa Red Diamonds':'🔴⚫',
};
const clubBadges=new Map(minicampClubs.map(name=>[name,colours[name]??'⚪⚫']));
export function teamBadge(name:string,_kind:'clube'|'seleção'|'misto'='clube'):string{
 const exact=name.trim();
 if(nationBadges.has(exact))return nationBadges.get(exact)!;
 return clubBadges.get(exact)??'⚪⚫';
}
export function teamLabel(name:string|undefined,kind:'clube'|'seleção'|'misto'='clube'):string{
 return name?`${teamBadge(name,kind)} ${name}`:'A sortear';
}
