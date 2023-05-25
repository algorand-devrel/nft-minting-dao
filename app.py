from pathlib import Path
from typing import Literal

from beaker import *
from beaker.lib.storage import BoxMapping
from pyteal import *


class NFTProposal(abi.NamedTuple):
    url: abi.Field[abi.String]
    metadata_hash: abi.Field[abi.StaticArray[abi.Byte, Literal[32]]]
    name: abi.Field[abi.String]
    unit_name: abi.Field[abi.String]
    reserve: abi.Field[abi.Address]

###############
# DAO Contract
###############

class DAOState:
    # Global Storage
    winning_proposal_votes = GlobalStateValue(
        stack_type=TealType.uint64, default=Int(0)
    )

    winning_proposal = GlobalStateValue(stack_type=TealType.bytes, default=Bytes(""))

    # Box Storage
    has_voted = BoxMapping(key_type=abi.Address, value_type=abi.Bool)
    
    proposals = BoxMapping(
        key_type=abi.Tuple2[abi.Address, abi.Uint64],
        value_type=NFTProposal,
        prefix=Bytes("p-"),
    )

    votes = BoxMapping(
        key_type=abi.Tuple2[abi.Address, abi.Uint64],
        value_type=abi.Uint64,
        prefix=Bytes("v-"),
    )

dao = Application("DAO", state=DAOState)


@dao.create(bare=True)
def create() -> Expr:
    return dao.initialize_global_state()


@dao.external
def add_proposal(
    proposal: NFTProposal, proposal_id: abi.Uint64, mbr_payment: abi.PaymentTransaction
) -> Expr:
    proposal_key = abi.make(abi.Tuple2[abi.Address, abi.Uint64])
    addr = abi.Address()

    return Seq(
        # Assert MBR payment is going to the contract
        Assert(mbr_payment.get().receiver() == Global.current_application_address()),
        # Get current MBR before adding proposal
        pre_mbr := AccountParam.minBalance(Global.current_application_address()),
        # Set proposal key
        addr.set(Txn.sender()),
        proposal_key.set(addr, proposal_id),
        # Check if the proposal already exists
        Assert(dao.state.proposals[proposal_key].exists() == Int(0)),
        # Not using .get() here because desc is already a abi.String
        dao.state.proposals[proposal_key].set(proposal),
        # Verify payment covers MBR difference
        current_mbr := AccountParam.minBalance(Global.current_application_address()),
        Assert(mbr_payment.get().amount() >= current_mbr.value() - pre_mbr.value()),
    )


@dao.external
def vote(proposer: abi.Address, proposal_id: abi.Uint64) -> Expr:
    total_votes = abi.Uint64()
    current_votes = abi.Uint64()
    true_value = abi.Bool()
    zero_val = abi.Uint64()
    proposal_key = abi.make(abi.Tuple2[abi.Address, abi.Uint64])

    return Seq(
        zero_val.set(Int(0)),
        proposal_key.set(proposer, proposal_id),
        # Make sure we haven't voted yet
        Assert(dao.state.has_voted[Txn.sender()].exists() == Int(0)),
        # Get current vote count
        If(dao.state.votes[proposal_key].exists() == Int(0)).Then(
            dao.state.votes[proposal_key].set(zero_val)
        ),
        dao.state.votes[proposal_key].store_into(current_votes),
        # Increment and save total vote count
        total_votes.set(current_votes.get() + Int(1)),
        dao.state.votes[proposal_key].set(total_votes),
        # Check if this proposal is now winning
        If(total_votes.get() > dao.state.winning_proposal_votes.get()).Then(
            dao.state.winning_proposal_votes.set(total_votes.get()),
            dao.state.winning_proposal.set(proposal_key.encode()),
        ),
        # Set has_voted to true
        true_value.set(value=True),
        dao.state.has_voted[Txn.sender()].set(true_value),
    )


@dao.external
def mint(minter_app: abi.Application, *, output: abi.Uint64) -> Expr:
    proposal_key = abi.make(abi.Tuple2[abi.Address, abi.Uint64])
    proposal = NFTProposal()

    return Seq(
        # Get the winning proposal key
        proposal_key.decode(dao.state.winning_proposal.get()),
        # Get the winning proposal
        dao.state.proposals[proposal_key].store_into(proposal),
        # Call NFT minter
        InnerTxnBuilder.ExecuteMethodCall(
            app_id=Tmpl.Int("TMPL_MINTER_APP"),
            method_signature=f"mint_nft({NFTProposal().type_spec()})uint64",
            args=[proposal],
        ),
        # Return created asset
        output.set(Btoi(Suffix(InnerTxn.last_log(), Int(4)))),
    )


#####################
# NFT Minter Contract
#####################

minter = Application("Minter")


@minter.external
def mint_nft(proposal: NFTProposal, *, output: abi.Uint64) -> Expr:
    name = abi.String()
    unit_name = abi.String()
    reserve = abi.Address()
    url = abi.String()
    metadata_hash = abi.make(abi.StaticArray[abi.Byte, Literal[32]])
    abi.make(abi.Tuple2[abi.Address, abi.Uint64])

    return Seq(
        # Get properties from proposal and mint NFT
        proposal.name.store_into(name),
        proposal.unit_name.store_into(unit_name),
        proposal.reserve.store_into(reserve),
        proposal.url.store_into(url),
        proposal.metadata_hash.store_into(metadata_hash),
        InnerTxnBuilder.Execute(
            {
                TxnField.type_enum: TxnType.AssetConfig,
                TxnField.config_asset_name: name.get(),
                TxnField.config_asset_unit_name: unit_name.get(),
                TxnField.config_asset_reserve: reserve.get(),
                TxnField.config_asset_url: url.get(),
                TxnField.config_asset_metadata_hash: metadata_hash.encode(),
                TxnField.config_asset_total: Int(1),
                TxnField.fee: Int(0),
            }
        ),
        # Return created asset
        output.set(InnerTxn.created_asset_id()),
    )


if __name__ == "__main__":
    dao.build().export(Path(__file__).resolve().parent / f"./artifacts/{dao.name}")
    minter.build().export(
        Path(__file__).resolve().parent / f"./artifacts/{minter.name}"
    )
