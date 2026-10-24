/** Every seat gram can fill. Importing this module registers each domain with the
 * system of work; import it wherever a domain is looked up by kind. */
import './cash-application.ts';
import './tour-settlements.ts';
export {allDomains,domainByKind,domainFor,seatKinds} from './seat-domain.ts';
export type {SeatDomain} from './seat-domain.ts';
